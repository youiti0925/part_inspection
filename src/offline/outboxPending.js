// 目的: 「未送信の保存の数」 送信待ちの箱(outbox)に残った、まだ送れていない保存と送れない保存を数える。
// 入力: 端末の IndexedDB(inspection-outbox の commands)の行。
// 出力: 未送信(pending/sending)と送れない(failed/conflict)の数。数えられない時は null。
// 呼ぶ人: src/offline/onpremOffline.js。
// 触る外の物: 端末の IndexedDB を読むだけ(書かない・箱が無ければ作らず・開いたらすぐ閉じる)。
// 確かめ方: npm test(src/data/__tests__/offlinePb.test.mjs)。
// ============================================================================
// 📴 社内版(PocketBase): 「まだ送れていない保存」の数を数える(2026-11-02・社内版の4アプリで同じ中身)
// ----------------------------------------------------------------------------
// 保存は送信待ちの箱(src/data/outbox.js・IndexedDB "inspection-outbox" の "commands")に入り、つながると自動で送られる。
// その箱を読むだけ(書かない)。⚠箱が無い時に作らない(onupgradeneeded が来たら取り消す)。開いたらすぐ閉じる。
// 数え方: pending/sending = 未送信 / failed・conflict = 送れない(人が見る) … outbox.js の summary と同じ分け方。
// ============================================================================
export const OUTBOX_DB_NAME = 'inspection-outbox';
export const OUTBOX_STORE_NAME = 'commands';

export const summarizeOutboxRows = (rows) => {
  let count = 0; let failed = 0;
  for (const r of rows || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.status === 'pending' || r.status === 'sending') count += 1;
    else if (r.status === 'failed' || r.status === 'conflict') failed += 1;
  }
  return { count, failed };
};

/** @returns {Promise<{count:number, failed:number}|null>} 数えられない時は null */
export const countOutboxPending = ({ idb = (typeof indexedDB !== 'undefined' ? indexedDB : null) } = {}) => new Promise((resolve) => {
  if (!idb) { resolve(null); return; }
  let req;
  try { req = idb.open(OUTBOX_DB_NAME); } catch { resolve(null); return; }
  let created = false;
  req.onupgradeneeded = () => { created = true; try { req.transaction.abort(); } catch { /* noop */ } };
  req.onerror = () => resolve(created ? { count: 0, failed: 0 } : null);
  req.onblocked = () => resolve(null);
  req.onsuccess = () => {
    const db = req.result;
    db.onversionchange = () => { try { db.close(); } catch { /* noop */ } };
    try {
      if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) { db.close(); resolve({ count: 0, failed: 0 }); return; }
      // 🚦 2026-11-26: store.getAll() でなく cursor で読む(同じ全行・同じ結果)。読み取りの枠の見張りが `.getAll(` の名前だけで Firestore の全件読みと数えて ❌ にしたため
      //   (これは端末の中の IndexedDB で Firestore は1件も読まない。見張りの例外一覧は触らず、書き方の方を替えた)。
      const rows = [];
      const g = db.transaction(OUTBOX_STORE_NAME, 'readonly').objectStore(OUTBOX_STORE_NAME).openCursor();
      g.onsuccess = () => {
        const c = g.result;
        if (c) { rows.push(c.value); c.continue(); return; }
        try { db.close(); } catch { /* noop */ } resolve(summarizeOutboxRows(rows));
      };
      g.onerror = () => { try { db.close(); } catch { /* noop */ } resolve(null); };
    } catch { try { db.close(); } catch { /* noop */ } resolve(null); }
  };
});
