// ============================================================================
// 送信待ちの箱(オフラインでも保存できるようにする)
// ----------------------------------------------------------------------------
// ⚠⚠ **これが移行で一番大きい穴。**
//   Firestore は persistentLocalCache を有効にしてあるので、電波が切れても保存は
//   端末に貯まり、つながった時に自動で送られる。現場の Wi-Fi は実際に切れる。
//   PocketBase にはこの仕組みが **無い**。作らないと「保存したのに消える」。
//
// 満たすこと:
//   ① 端末に残る(ブラウザを閉じても・電源を切っても消えない → IndexedDB)
//   ② 1回だけ効く(送ったのに返事が来ず、もう一度送っても二重にならない → commandId)
//   ③ 自動で送り直す(つながったら勝手に流す・失敗しても諦めない)
//   ④ ぶつかったら **黙って上書きしない**(人に知らせる)
//   ⑤ 何件待っているかが画面から見える
//
// ⚠印(DATA_DELETE / DATA_SERVER_NOW)は「ただのオブジェクト」なので IndexedDB に
//   そのまま入る。Firestore の deleteField() は入らない(構造化複製できない)。
//   これがオフライン再送を作れるようにした理由。
// ============================================================================

export const OUTBOX_DB = 'inspection-outbox';
export const OUTBOX_STORE = 'commands';
export const STATUS = Object.freeze({
  PENDING: 'pending',   // これから送る
  SENDING: 'sending',   // 送っている最中
  CONFLICT: 'conflict', // 他の端末が先に保存していた(人の判断が要る)
  FAILED: 'failed',     // 何度やっても送れない(消さずに残す)
});

// ----------------------------------------------------------------------------
// 置き場所(IndexedDB)。テストでは Map の実装に差し替えられる。
// ----------------------------------------------------------------------------
export const createMemoryStore = () => {
  const m = new Map();
  return {
    kind: 'memory',
    put: async (rec) => { m.set(rec.commandId, { ...rec }); },
    get: async (id) => (m.has(id) ? { ...m.get(id) } : null),
    del: async (id) => { m.delete(id); },
    all: async () => [...m.values()].map((r) => ({ ...r })).sort((a, b) => a.seq - b.seq),
    clear: async () => { m.clear(); },
  };
};

export const createIdbStore = ({ dbName = OUTBOX_DB, storeName = OUTBOX_STORE } = {}) => {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          const os = db.createObjectStore(storeName, { keyPath: 'commandId' });
          os.createIndex('seq', 'seq');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  };
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const os = t.objectStore(storeName);
      let out;
      try { out = fn(os); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  return {
    kind: 'indexeddb',
    put: (rec) => tx('readwrite', (os) => os.put(rec)),
    get: (id) => tx('readonly', (os) => os.get(id)),
    del: (id) => tx('readwrite', (os) => os.delete(id)),
    all: async () => {
      const rows = await tx('readonly', (os) => os.getAll());
      return (rows || []).sort((a, b) => a.seq - b.seq);
    },
    clear: () => tx('readwrite', (os) => os.clear()),
  };
};

/** この端末を表す名前。⚠端末をまたいで同じ commandId にならないようにする。 */
export const deviceIdOf = (storage) => {
  const KEY = 'outbox.deviceId';
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (s) {
      let v = s.getItem(KEY);
      if (!v) { v = `d${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`; s.setItem(KEY, v); }
      return v;
    }
  } catch { /* 使えなければ都度作る */ }
  return `d${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
};

// ----------------------------------------------------------------------------
// 送信待ちの箱
// ----------------------------------------------------------------------------
/**
 * @param apply  実際に送る関数 (cmd) => Promise<{ok:true}|{conflict:true, detail}>
 *               ⚠通信の失敗は **例外を投げる** こと(「ぶつかった」と混ぜない)。
 * @param isOnline  つながっているかを返す関数
 */
export const createOutbox = ({
  store, apply, deviceId, maxTries = 8, backoffMs = 1000, maxBackoffMs = 60000,
  onChange = () => {}, isOnline = () => true, now = () => Date.now(),
} = {}) => {
  if (!store) throw new Error('createOutbox: store が必要です');
  if (typeof apply !== 'function') throw new Error('createOutbox: apply が必要です');
  const dev = deviceId || deviceIdOf();
  let seq = 0;
  let draining = false;
  let stopped = false;

  const notify = async () => { try { onChange(await summary()); } catch { /* 画面の都合で落とさない */ } };

  const summary = async () => {
    const rows = await store.all();
    return {
      total: rows.length,
      pending: rows.filter((r) => r.status === STATUS.PENDING || r.status === STATUS.SENDING).length,
      conflict: rows.filter((r) => r.status === STATUS.CONFLICT).length,
      failed: rows.filter((r) => r.status === STATUS.FAILED).length,
      oldestAt: rows.length ? Math.min(...rows.map((r) => r.createdAt)) : null,
    };
  };

  /** 送信待ちに入れる。⚠ここで既に「保存できた」と扱ってよい(後で必ず送る)。 */
  const enqueue = async (cmd) => {
    seq += 1;
    const rec = {
      commandId: `${dev}-${now().toString(36)}-${seq}`,
      seq: now() * 1000 + seq,
      status: STATUS.PENDING,
      tries: 0,
      createdAt: now(),
      nextAt: 0,
      lastError: null,
      ...cmd,
    };
    await store.put(rec);
    await notify();
    drain();
    return rec.commandId;
  };

  /** 溜まっている分を順番に送る。⚠順番を守る(同じ書類への保存が入れ替わると結果が変わる)。 */
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      for (;;) {
        if (stopped || !isOnline()) break;
        const rows = await store.all();
        const next = rows.find((r) => r.status === STATUS.PENDING && (r.nextAt || 0) <= now());
        if (!next) break;

        await store.put({ ...next, status: STATUS.SENDING });
        try {
          const res = await apply(next);
          if (res && res.conflict) {
            // ④ 黙って上書きしない。人が見て決められるように残す。
            await store.put({ ...next, status: STATUS.CONFLICT, lastError: res.detail || '他の端末が先に保存しました' });
          } else {
            await store.del(next.commandId);
          }
        } catch (e) {
          const tries = (next.tries || 0) + 1;
          const wait = Math.min(backoffMs * 2 ** (tries - 1), maxBackoffMs);
          await store.put({
            ...next,
            status: tries >= maxTries ? STATUS.FAILED : STATUS.PENDING,
            tries,
            nextAt: now() + wait,
            lastError: String(e?.message || e),
          });
          // ⚠1件で止まらない。次のものは送ってみる。ただし通信が切れているなら抜ける。
          if (!isOnline()) break;
          if (tries < maxTries) break; // 待ち時間を置くため、いったん抜ける
        }
        await notify();
      }
    } finally {
      draining = false;
      await notify();
    }
  };

  /** 失敗・衝突したものをもう一度送る(人が「やり直す」を押した時)。 */
  const retry = async (commandId) => {
    const rec = await store.get(commandId);
    if (!rec) return false;
    await store.put({ ...rec, status: STATUS.PENDING, tries: 0, nextAt: 0, lastError: null });
    await notify();
    drain();
    return true;
  };

  /** 人が「これは捨てる」と決めた時だけ消す。⚠自動では消さない。 */
  const discard = async (commandId) => { await store.del(commandId); await notify(); };

  return {
    deviceId: dev,
    enqueue,
    drain,
    retry,
    discard,
    summary,
    list: () => store.all(),
    stop: () => { stopped = true; },
    start: () => { stopped = false; drain(); },
    /** ブラウザの「つながった」を拾って自動で流す。 */
    attachToWindow: (win = typeof window !== 'undefined' ? window : null) => {
      if (!win) return () => {};
      const on = () => drain();
      win.addEventListener('online', on);
      const iv = setInterval(() => { if (isOnline()) drain(); }, 15000);
      return () => { win.removeEventListener('online', on); clearInterval(iv); };
    },
  };
};
