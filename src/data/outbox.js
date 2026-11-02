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
// 📴 2026-11-02 「サーバーに届かない」失敗か(=つながれば送れる)。⚠サーバーが断った(4xx)とは分ける。
//   PocketBase の窓口(pbClient)の PbNetworkError・入口の 502/503/504・ブラウザの fetch 失敗の字。
//   文字(前の版で箱に残った lastError)も渡せる。
// ----------------------------------------------------------------------------
const NET_FAIL_RE = /PocketBase 通信失敗|PocketBase 50[234]\b|Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;
export const isNetworkFailure = (e) => {
  if (e == null) return false;
  if (typeof e === 'object') {
    if (e.name === 'PbNetworkError') return true;
    const st = Number(e.status);
    if (st === 502 || st === 503 || st === 504) return true;
    return NET_FAIL_RE.test(String(e.message || ''));
  }
  return NET_FAIL_RE.test(String(e));
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
  const rnd = () => Math.random().toString(36).slice(2, 8);
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
      // ⚠アプリを開き直すと seq は 0 に戻る。時刻(ミリ秒)と seq だけだと、
      //   同じミリ秒に開き直した時に **前の送信待ちと同じIDになって上書きしてしまう**。
      //   偶然に頼らないよう、端末ごとに乱数を1つ混ぜる。
      commandId: `${dev}-${now().toString(36)}-${seq}-${rnd()}`,
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

  /**
   * 📴 2026-11-02 送れずに止まった物を「これから送る」へ戻す。
   *   ① SENDING のまま残った物: 送っている最中に画面が閉じた/再読込した。drain は PENDING しか拾わないので、
   *      前は **二度と送られなかった**(再読込しても箱に残るだけ)。開き直した最初の drain で PENDING に戻す。
   *      ⚠二重にならない: 送る時の命令ID(commandId)の印で、もう効いていれば同じ中身は2回効かない(apply 側の決まり)。
   *   ② 通信の失敗で FAILED になっていた物(この直しより前の版で箱に入った物): つながった時に戻す。
   *      ⚠サーバーが断った FAILED(netFail でない)は戻さない(人が見るまで残す決まりのまま)。
   */
  let recoveredOnce = false;
  const recoverStuck = async ({ sending = false } = {}) => {
    const rows = await store.all();
    let n = 0;
    for (const r of rows) {
      const stuckSending = sending && r.status === STATUS.SENDING;
      const netFailed = r.status === STATUS.FAILED && (r.netFail || isNetworkFailure(r.lastError));
      // ③ つながった合図の時は、届かずに待っている物(PENDING・netFail)の待ち時間も0にする(最大60秒待たずにすぐ送る)
      const netWaiting = !sending && r.status === STATUS.PENDING && r.netFail && (r.nextAt || 0) > now();
      if (!stuckSending && !netFailed && !netWaiting) continue;
      await store.put({ ...r, status: STATUS.PENDING, nextAt: 0, ...(netFailed ? { tries: 0, netFail: true } : {}) });
      n += 1;
    }
    return n;
  };

  /** 溜まっている分を順番に送る。⚠順番を守る(同じ書類への保存が入れ替わると結果が変わる)。 */
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    if (!recoveredOnce) {
      recoveredOnce = true;
      try { if (await recoverStuck({ sending: true })) await notify(); } catch { /* 戻せなくても送れる物は送る */ }
    }
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
          // 📴 2026-11-02 「サーバーに届かない」失敗は回数に数えない(FAILED にしない)。
          //   ⚠前は通信の失敗も8回で FAILED になり、FAILED は自動では二度と送らなかった。間隔は 1+2+4+…+60 秒 ≒ 3分なので、
          //     社内 LAN が3分以上落ちると、落ちている間の保存が **つながっても送られないまま** 端末に残った。
          //   届かない間は間隔だけ伸ばして(上限 maxBackoffMs)待ち続け、つながったら送る。FAILED はサーバーが断った時だけ。
          const net = isNetworkFailure(e);
          const tries = net ? (next.tries || 0) : (next.tries || 0) + 1;
          const netTries = net ? (next.netTries || 0) + 1 : 0;
          const wait = Math.min(backoffMs * 2 ** ((net ? netTries : tries) - 1), maxBackoffMs);
          await store.put({
            ...next,
            status: (!net && tries >= maxTries) ? STATUS.FAILED : STATUS.PENDING,
            tries,
            netTries,
            netFail: net,
            nextAt: now() + wait,
            lastError: String(e?.message || e),
          });
          // ⚠1件で止まらない。次のものは送ってみる。ただし通信が切れているなら抜ける。
          if (!isOnline()) break;
          if (net || tries < maxTries) break; // 待ち時間を置くため、いったん抜ける(届かない時は後ろの物も届かない)
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
      // 📴 つながった合図: 通信の失敗で FAILED になっていた物も戻してから流す(2026-11-02)
      //   'app-reconnected' = 「オフライン中」の札(offlineBadge.js)が、届かなかったサーバーに届く様になったのを見つけた合図
      //   (社内 LAN だけ落ちた時はブラウザの online は来ない)。
      const on = () => { recoverStuck().catch(() => 0).then((n) => (n ? notify() : null)).then(() => drain()); };
      win.addEventListener('online', on);
      win.addEventListener('app-reconnected', on);
      const iv = setInterval(() => { if (isOnline()) drain(); }, 15000);
      return () => { win.removeEventListener('online', on); win.removeEventListener('app-reconnected', on); clearInterval(iv); };
    },
  };
};
