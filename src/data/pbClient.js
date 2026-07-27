// ============================================================================
// PocketBase への最小限のクライアント(fetch だけ・SDK を使わない)
// ----------------------------------------------------------------------------
// ブラウザでも Node でも同じものを使う(移行ツールと画面で挙動を揃えるため)。
//
// なぜ SDK を使わないか:
//   リポジトリに入っている JS SDK は 0.26.8、動かすサーバーは 0.39.9 で世代が違う。
//   SDK の層でエラーの形が変わると、**「取れなかった」と「通信に失敗した」の区別**が
//   つかなくなる。これは権利取り(claimOnce)の正しさに直結するので HTTP をそのまま扱う。
//
// ⚠購読(SSE)は EventSource を使わない。EventSource は Authorization ヘッダを
//   付けられないため。fetch のストリームで読む。
//
// ⚠エラーは種類ごとに別のクラスにする。**全部 catch して false を返すのは禁止。**
// ============================================================================

export class PbHttpError extends Error {
  constructor(status, body, url) {
    super(`PocketBase ${status} ${url}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.name = 'PbHttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
  /** 一意制約(= 既に誰かが取っている)か。 */
  get isUnique() {
    if (this.status !== 400) return false;
    return /validation_not_unique|UNIQUE constraint|already exists/i.test(JSON.stringify(this.body || ''));
  }
}

export class PbNetworkError extends Error {
  constructor(cause, url) {
    super(`PocketBase 通信失敗 ${url}: ${cause?.message || cause}`);
    this.name = 'PbNetworkError'; this.cause = cause; this.url = url;
  }
}

/** 権利取りの結果。⚠4つを混ぜない。 */
export const CLAIM = Object.freeze({ OK: 'ok', TAKEN: 'taken', MISSING: 'missing', ERROR: 'error' });

export const createPbClient = ({ url, fetchImpl } = {}) => {
  if (!url) throw new Error('createPbClient: url が必要です');
  const base = String(url).replace(/\/+$/, '');
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let token = null;
  // ⚠⚠ログインが終わる前に読みに行かせない。
  //   PocketBase の listRule は **絞り込みとして効く** ので、未ログインの一覧取得は
  //   403 ではなく **200 + 0件** が返る。つまり「まだログインできていない」が
  //   「データが1件も無い」と区別できない。実測(2026-07-27): サーバに139件あるのに
  //   起動直後の画面は0件、エラーも出なかった。→ 全リクエストをログインの後ろに並べる。
  let ready = null;

  const req = async (path, { method = 'GET', body, headers = {}, raw = false, signal } = {}) => {
    if (ready) { try { await ready; } catch { /* 失敗の中身は isAuthed() と各リクエストで分かる */ } }
    const full = `${base}${path}`;
    const h = { ...headers };
    if (token) h.Authorization = token;
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (body !== undefined && !isForm) h['Content-Type'] = 'application/json';
    let res;
    try {
      res = await doFetch(full, { method, headers: h, signal, body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)) });
    } catch (e) {
      // ⚠ここを「取れなかった」に潰さない。通信の失敗は別の事実。
      throw new PbNetworkError(e, full);
    }
    if (raw) { if (!res.ok) throw new PbHttpError(res.status, await res.text().catch(() => ''), full); return res; }
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* そのまま */ }
    if (!res.ok) throw new PbHttpError(res.status, parsed, full);
    return parsed;
  };

  const api = {
    url: base,
    get token() { return token; },
    setToken: (t) => { token = t; },
    isAuthed: () => !!token,
    /**
     * ログインの約束を登録する。以後、**すべてのリクエストはこれが終わるまで待つ**。
     * ⚠これを使わずに「ログインを投げっぱなし」にすると、起動直後の読み出しが
     *   未ログインのまま走り、0件が返って画面が空になる(エラーも出ない)。
     */
    setReady: (p) => { ready = p; },
    whenReady: () => (ready || Promise.resolve()),

    health: () => req('/api/health'),
    authSuperuser: async (email, password) => {
      const r = await req('/api/collections/_superusers/auth-with-password', { method: 'POST', body: { identity: email, password } });
      token = r.token; return r;
    },
    /** 端末用の利用者アカウントでログインする(移行後の本番はこちら)。 */
    authUser: async (identity, password, collection = 'users') => {
      const r = await req(`/api/collections/${encodeURIComponent(collection)}/auth-with-password`, { method: 'POST', body: { identity, password } });
      token = r.token; return r;
    },
    authRefresh: async (collection = 'users') => {
      const r = await req(`/api/collections/${encodeURIComponent(collection)}/auth-refresh`, { method: 'POST' });
      token = r.token; return r;
    },

    // --- コレクション --------------------------------------------------------
    listCollections: async () => (await req('/api/collections?perPage=200')).items || [],
    createCollection: (def) => req('/api/collections', { method: 'POST', body: def }),
    updateCollection: (nameOrId, patch) => req(`/api/collections/${encodeURIComponent(nameOrId)}`, { method: 'PATCH', body: patch }),
    deleteCollection: (nameOrId) => req(`/api/collections/${encodeURIComponent(nameOrId)}`, { method: 'DELETE' }),
    getSettings: () => req('/api/settings'),
    updateSettings: (patch) => req('/api/settings', { method: 'PATCH', body: patch }),
    batch: (requests) => req('/api/batch', { method: 'POST', body: { requests } }),

    // --- レコード ------------------------------------------------------------
    create: (col, data) => req(`/api/collections/${encodeURIComponent(col)}/records`, { method: 'POST', body: data }),
    update: (col, id, data) => req(`/api/collections/${encodeURIComponent(col)}/records/${encodeURIComponent(id)}`, { method: 'PATCH', body: data }),
    remove: (col, id) => req(`/api/collections/${encodeURIComponent(col)}/records/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    getOne: (col, id) => req(`/api/collections/${encodeURIComponent(col)}/records/${encodeURIComponent(id)}`),

    listPage: (col, { page = 1, perPage = 200, filter, sort, fields } = {}) => {
      const q = new URLSearchParams({ page: String(page), perPage: String(perPage) });
      if (filter) q.set('filter', filter);
      if (sort) q.set('sort', sort);
      if (fields) q.set('fields', fields);
      return req(`/api/collections/${encodeURIComponent(col)}/records?${q}`);
    },
    /** 全部取る。⚠件数を勝手に切り捨てない(切ると集計が静かに狂う)。 */
    listAll: async (col, opts = {}) => {
      const out = []; let page = 1;
      for (;;) {
        const r = await api.listPage(col, { ...opts, page });
        out.push(...(r.items || []));
        if (!r.items?.length || page >= (r.totalPages || 1)) break;
        page++;
      }
      return out;
    },
    count: async (col, filter) => (await api.listPage(col, { page: 1, perPage: 1, filter, fields: 'id' })).totalItems ?? 0,

    fileUrl: (col, recId, filename) => `${base}/api/files/${encodeURIComponent(col)}/${encodeURIComponent(recId)}/${encodeURIComponent(filename)}`,
    fetchFileResponse: (col, recId, filename) => req(`/api/files/${encodeURIComponent(col)}/${encodeURIComponent(recId)}/${encodeURIComponent(filename)}`, { raw: true }),

    // --- 購読(SSE) ---------------------------------------------------------
    // ⚠実測(v0.39.9): 購読の filter / fields は **受け付けるが効かない**。
    //   ns="A" だけを購読しても ns="B" の変更が届く。→ 絞り込みは必ず端末側で行う。
    openRealtime: ({ collections, onEvent, onOpen, onError }) => {
      const ac = new AbortController();
      let closed = false;
      let clientId = null;
      (async () => {
        // ⚠購読もログインの後ろに並べる。未ログインで開くと何も届かない。
        if (ready) { try { await ready; } catch { /* 下の再接続で拾う */ } }
        for (let backoff = 500; !closed;) {
          try {
            const res = await doFetch(`${base}/api/realtime`, {
              headers: { Accept: 'text/event-stream', ...(token ? { Authorization: token } : {}) },
              signal: ac.signal,
            });
            if (!res.ok || !res.body) throw new PbHttpError(res.status, 'SSE を開けません', `${base}/api/realtime`);
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            backoff = 500;
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              let i;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
                const ev = (chunk.match(/^event:\s*(.+)$/m) || [])[1] || 'message';
                const dataLine = (chunk.match(/^data:\s*([\s\S]*)$/m) || [])[1] || '';
                let data = dataLine;
                try { data = JSON.parse(dataLine); } catch { /* 文字列のまま */ }
                if (ev === 'PB_CONNECT') {
                  clientId = data?.clientId || null;
                  await req('/api/realtime', { method: 'POST', body: { clientId, subscriptions: collections } });
                  onOpen && onOpen(clientId);
                } else if (data && data.record) {
                  onEvent && onEvent({ action: data.action, record: data.record });
                }
              }
            }
          } catch (e) {
            if (closed || ac.signal.aborted) return;
            onError && onError(e);
          }
          if (closed) return;
          // ⚠切れたら黙って諦めない。つながるまで間隔を空けて張り直す。
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000);
        }
      })();
      return () => { closed = true; ac.abort(); };
    },

    _req: req,
  };
  return api;
};

/**
 * 「この1回を実行する権利」を1台だけが取る。
 * ⚠実装は **UNIQUE インデックスへの create 一発**。
 *   「読んでから無ければ書く」にすると、2台が同じ瞬間に読んだときに両方が取れる。
 *   実測(v0.39.9): サーバ側フックで rev を見比べる方式は 100回中98回で両方通った。
 *   UNIQUE への create は 10台×100回で常に勝者ちょうど1台。
 * ⚠通信失敗・認証失敗・サーバーエラーを acquired:false と同一に扱わない。
 */
export const claimOnce = async (client, scope, claimId, { owner, meta, collection = 'claims' } = {}) => {
  try {
    const rec = await client.create(collection, { scope, claimId, owner: owner || '', meta: meta || {} });
    return { acquired: true, reason: CLAIM.OK, recordId: rec.id };
  } catch (e) {
    if (e instanceof PbHttpError && e.isUnique) return { acquired: false, reason: CLAIM.TAKEN };
    return { acquired: false, reason: CLAIM.ERROR, error: e };
  }
};
