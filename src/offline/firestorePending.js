// ============================================================================
// 📴 Firestore の「まだ送れていない保存」の数を数える(2026-11-02・Firebase 版の4アプリで同じ中身)
// ----------------------------------------------------------------------------
// persistentLocalCache(端末の控え)を使っているので、電波が切れている間の保存は端末の IndexedDB の
// 待ち行列(Firestore の DB "firestore/[DEFAULT]/<projectId>/main" の "mutations")に入り、つながると SDK が自動で送る。
// 再読込しても待ち行列は残る(SDK が起動の時に読み戻す)。その **件数** を札に出す為に、待ち行列を数えるだけ。
// ⚠読むだけ。書かない。Firestore の読み取り(課金)は0。
// ⚠⚠ DB が無い時に作ってはいけない(版 1 の空の DB が出来ると、後で SDK が開く時に作りが壊れる)。
//   → indexedDB.databases() で在るか確かめ、在っても onupgradeneeded が来たら(=無かった)取り消す。
// ⚠開いたらすぐ閉じる(SDK が版を上げる時に待たせない)。versionchange が来たら即閉じる。
// ⚠SDK の中の名前に頼っている。名前が変わったら null(=数えられない)を返し、札は「数えられない」側へ落ちる(嘘の 0 を言わない)。
// ============================================================================

export const firestoreDbName = (projectId, database = '(default)') =>
  `firestore/[DEFAULT]/${database === '(default)' ? projectId : `${projectId}.${database}`}/main`;

/** @returns {Promise<number|null>} 待ち行列の件数。数えられない時は null。 */
export const countFirestorePending = async (projectId, { idb = (typeof indexedDB !== 'undefined' ? indexedDB : null) } = {}) => {
  if (!idb || !projectId) return null;
  const name = firestoreDbName(projectId);
  try {
    if (typeof idb.databases === 'function') {
      const list = await idb.databases();
      if (!list.some((d) => d && d.name === name)) return 0;   // 控えがまだ無い = 待ちも無い
    }
  } catch { /* databases() が使えない端末は下で確かめる */ }
  return new Promise((resolve) => {
    let req;
    try { req = idb.open(name); } catch { resolve(null); return; }
    let created = false;
    req.onupgradeneeded = () => { created = true; try { req.transaction.abort(); } catch { /* noop */ } };   // 無かった: 作らない
    req.onerror = () => resolve(created ? 0 : null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch { /* noop */ } };
      try {
        if (!db.objectStoreNames.contains('mutations')) { db.close(); resolve(null); return; }
        const c = db.transaction('mutations', 'readonly').objectStore('mutations').count();
        c.onsuccess = () => { try { db.close(); } catch { /* noop */ } resolve(Number(c.result) || 0); };
        c.onerror = () => { try { db.close(); } catch { /* noop */ } resolve(null); };
      } catch { try { db.close(); } catch { /* noop */ } resolve(null); }
    };
  });
};
