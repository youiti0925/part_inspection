// ============================================================================
// 🔁 社内版(PocketBase): 購読(SSE)が切れた後の張り直しと、切れていた間の取りこぼしの読み直し(2026-10-31)
// ----------------------------------------------------------------------------
// 何が困っていたか:
//   購読の張り直しそのものは pbClient が続ける(流れが閉じた・切れた → 間隔を空けて GET /api/realtime → 申し込みの POST)。
//   ただし ① 切れていた間の変更の知らせは、張り直しても **届かない**(PocketBase は溜めない)。保管庫は張り直した事を
//   知らないので、購読中の画面は古いまま・1回だけ読んだ一覧も古い控えを返し続けた。
//   ② サーバが落ちている間は張り直しの間隔が倍々に延び(最大30秒)、戻っても最大30秒待った。
//   ③ 回線が落ちた後の流れは、閉じずに黙ったまま残る事がある(何も届かないのに「つながっている」)。
// 形(⚠社内版のビルドだけ。読み直しの係 readRetry.js が取り付ける。いつものビルドでは出力に入らない):
//   ・ブラウザの fetch を包み、この保管庫のサーバの /api/realtime だけを見る(ほかの要求は素通し)。
//     - GET(流れを開く): 届かない間は、ここで待ちながら試し直す(0.5秒→倍々→10秒・online ならすぐ)。
//       pbClient の待ちは延びない(つながった時に返すので、戻ればすぐ張り直る)。
//       流れは中身をそのまま渡しながら、閉じた/切れた事と、届いた知らせの置き場所(ns/col)を知る。
//       online の合図で、つながっているつもりの流れを切る(pbClient が 0.5秒後に張り直す)。
//     - POST(申し込み)が通った = 購読が開いた。2回目から(または前に切れていた時)は「張り直せた」。
//   ・張り直せた時:
//     - 画面が購読している一覧 … サーバから1回だけ読み直す(backend.refresh。読めた答えは保管庫が購読の受け手へ配る)。
//       読み直しの最中にその一覧の知らせが届いたら、もう1回だけ読み直す(古い答えで新しい変更を消さない)。
//     - 購読していない一覧(1回だけ読んだ物) … 「古いかもしれない」印を付け、次に読まれた時にサーバから読み直してから返す。
//   ・起動して1回目に素直につながった時は読み直さない(起動の読みを2回にしない)。
// ⚠pbClient.js / pocketbaseBackend.js は いつものビルドの出力にも入っているので触らない(触ると本番の出力が変わる)。
// ⚠DOM も firebase も import しない(Node の試験で読めるように)。4アプリで同じ中身。
// ⚠⚠書き方の決まり(readRetry.js と同じ): { ...x } ・ async/await ・ ?. ・ ?? を使わない
//   (ビルドの対象 es2015 では補助の部品の呼び出しが、いつものビルドの出力にも残るため)。最上段で関数を呼ばない。
// ============================================================================

// 🔁 2026-10-31 追記(verify10 の本当の切断の試験で見つかった3つ):
//   ① 最終は pbClient が「端末の札の係(session.pbFetch)」を通して送る。その係は起動の時に包む前の fetch を握るので、
//      ブラウザの fetch を包んでも購読の要求が係を通らず、張り直しても読み直さなかった(製品・部品は通っていた)。
//      → 窓口(pbClient)に fetchHost(呼ぶ時に .fetch を引く入れ物)があれば、ブラウザの fetch ではなくそこを包む。
//   ② 入口(HTTPS の前段)は PocketBase が落ちている間 502 を返す。502 は「届いた答え」なので pbClient へそのまま渡り、
//      pbClient の待ちが倍々に延びた(最大30秒)。→ 5xx・408・429 は届かない時と同じに、ここで速く試し直す。
//   ③ 大きな一覧(最終の lot_images は 5千件・1ページ 8MB・26ページ)を読み直すたびに全部を順に読み、
//      同じ一覧を2つの係が同時に読んで(同じページを2回ずつ)、帯が消えるまで約31秒かかった。
//      → 一覧の読み(listAll)を包む: 同じ読みが同時に来たら1回にまとめる・前に全部読めた一覧は
//        「番号と更新時刻だけ」を読んで、変わった物だけを読む(消えた物は落とす)・全部読む時もページを並べて読む。
//        答えの中身と並びは、全部を順に読んだ時と同じ。
// 🔁 2026-10-31 追記(verify13 の残り):
//   ④ 流れが「黙って」死ぬ(相手が消えたのに閉じた知らせが来ない・TCP の片側だけ残る)と、何も気づかなかった。
//      → 見張り(心拍)を足す。流れが開いている間、REALTIME_PING_MS ごとにサーバの /api/health を短い時間切れで突く。
//        届かない(通信の失敗・時間切れ・5xx)= その流れはもう生きていない見込み → 流れを切る(pbClient が張り直し、
//        つながった時に上の「張り直せた → 読み直し」がそのまま動く)。
//        また PocketBase は何も送らない流れを5分で閉じる(IdleTimeout)ので、REALTIME_IDLE_MS(5分半)何も届かない流れは、
//        閉じた知らせを取りこぼした物として切る。画面が前に出た(visibilitychange)時も、すぐ1回突く。
//   ⑤ 全部読む途中で切れた一覧を、戻った後に「番号と更新時刻 → 足りない物を番号で」で読むと、最終の lot_images で
//      約16秒かかった(番号の一覧を作るだけでサーバは全件を読む・実測 1000件で約2秒)。
//      → 途中で切れた一覧は、戻ったらすぐ「全部をページで並べて」読み直す(控えは使わない)。
//        並びが決まっている読み(sort あり)は、1ページを LIST_FULL_PER_PAGE 件に広げて往復を減らす
//        (実測 5170件: 200件×4並び 7〜9秒 → 500件×4並び 約5秒。答えの中身と並びは同じ)。
/** 流れを開けない間の、ここでの試し直しの間隔(ミリ秒)。 */
export const RESYNC_RETRY_FIRST_MS = 500;
export const RESYNC_RETRY_MAX_MS = 10000;
/** ④ 流れが開いている間に、サーバへ届くかを確かめる間隔・その時間切れ・何も届かない流れを切るまで(ミリ秒)。 */
export const REALTIME_PING_MS = 20000;
export const REALTIME_PING_TIMEOUT_MS = 5000;
export const REALTIME_IDLE_MS = 330000;
/** 全部読む時に同時に読むページの数。 */
export const LIST_PARALLEL_PAGES = 4;
/** ⑤ 並びが決まっている(sort あり)一覧を全部読む時の1ページの件数(呼び手の件数より小さくはしない)。 */
export const LIST_FULL_PER_PAGE = 500;
/** 番号と更新時刻だけを読む時の1ページの件数(PocketBase の上限は 1000)。 */
export const LIST_IDS_PER_PAGE = 1000;
/** 変わった物だけを読む時、1回の要求で読む件数。 */
export const LIST_CHANGED_CHUNK = 100;

/** /api/realtime の答えのうち「届かない」と同じに扱う物(入口の 502/503/504・時間切れ・混雑)。 */
export const isRetryableRealtimeStatus = (status) => {
  const s = Number(status) || 0;
  return s === 0 || s >= 500 || s === 408 || s === 429;
};

const MARK = '__inspectionRealtimeResync';
const FETCH_MARK = '__inspectionRealtimeFetch';
const keyOf = (ns, col) => `${ns}/${col}`;
const splitKey = (k) => { const i = k.indexOf('/'); return [k.slice(0, i), k.slice(i + 1)]; };
const abortError = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; };

/** 要求の見出し(Authorization など)を読む(素の物・Headers のどちらでも)。 */
const headerOf = (init, name) => {
  const h = init && init.headers;
  if (!h) return null;
  if (typeof h.get === 'function') return h.get(name);
  const want = name.toLowerCase();
  const k = Object.keys(h).find((x) => x.toLowerCase() === want);
  return k ? h[k] : null;
};

/**
 * ブラウザの fetch を1回だけ包み、住所ごとの受け手へ回す(受け手が無い・受け手の物でない要求は素通し)。
 * ⚠同じ住所へ別の窓口(別のログイン)からも要求が来る事がある。受け手は owns(init) で自分の物かを見分ける。
 * @returns 外す関数
 */
const hookFetch = (host, url, handler) => {
  if (!host || typeof host.fetch !== 'function') return () => {};
  let reg = host.fetch[FETCH_MARK];
  if (!reg) {
    const orig = host.fetch;
    reg = { orig, handlers: new Map() };
    const wrapped = function inspectionFetch(input, init) {
      const u = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
      const hs = reg.handlers.get(u);
      const h = hs ? hs.find((x) => x.owns(init)) : null;
      if (h) return h.run(input, init, (a, b) => reg.orig.call(host, a, b));
      return reg.orig.apply(host, arguments);
    };
    wrapped[FETCH_MARK] = reg;
    host.fetch = wrapped;
  }
  if (!reg.handlers.has(url)) reg.handlers.set(url, []);
  reg.handlers.get(url).push(handler);
  return () => {
    const hs = reg.handlers.get(url) || [];
    const i = hs.indexOf(handler);
    if (i >= 0) hs.splice(i, 1);
    if (!hs.length) reg.handlers.delete(url);
    if (!reg.handlers.size && host.fetch && host.fetch[FETCH_MARK] === reg) host.fetch = reg.orig;
  };
};

const LIST_MARK = '__inspectionListAll';
/** 一覧まるごとの読み(保管庫が組む ns="…" && col="…")だけ、前の答えを覚えて差分で読み直す。 */
const WHOLE_COLLECTION_RE = /^ns="((?:[^"\\]|\\.)*)" && col="((?:[^"\\]|\\.)*)"$/;
const unq = (x) => String(x).replace(/\\(.)/g, '$1');
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const LIST_REMEMBER_MAX = 128;

/**
 * ③ 窓口(pbClient)の listAll を包む。答えの中身と並びは「1ページ目から順に全部読む」(元の listAll)と同じ。
 *   ・同じ読み(同じコレクション・同じ絞り込み)が同時に来たら、1回にまとめて同じ答えを返す。
 *   ・全部読む時は、1ページ目で総ページ数を知り、残りを LIST_PARALLEL_PAGES ずつ並べて読む。
 *   ・前に全部読めた一覧まるごと(ns && col)は、「番号と更新時刻」だけを読み、変わった・増えた物だけを読む。
 *     消えた物は落ちる。答えに更新時刻が無い・番号が変な形・変わった物が多い時は、全部読む(ごまかさない)。
 *   ・⑤ 全部読む途中で届かなくなった一覧は、覚えない(次は全部をページで並べて読む。前に全部読めた控えがあれば
 *     それは残す)。途中までの分から「足りない物を番号で」読むと、番号の一覧づくりでサーバが全件を読み、遅かった。
 *   ・並びが決まっている読み(sort あり)を全部読む時は、1ページを LIST_FULL_PER_PAGE 件に広げる(往復を減らす)。
 * ⚠要求はすべて client.listPage を呼ぶ時に引く(読み直しの係の「要求が通った」の合図もそのまま働く)。
 * @returns { undo(), stats() }
 */
const wrapListAll = (client) => {
  const none = { undo: () => {}, stats: () => null };
  if (!client || typeof client.listAll !== 'function' || typeof client.listPage !== 'function') return none;
  if (client[LIST_MARK]) return none;
  const origListAll = client.listAll;
  const inflight = new Map();   // 読みの鍵 -> Promise(同時に来た同じ読みを1回にまとめる)
  const last = new Map();       // 一覧まるごとの鍵 -> { recs: 前に全部読めた答え(レコード) }
  const st = { calls: 0, shared: 0, full: 0, delta: 0, deltaFallback: 0, pages: 0, changed: 0 };

  const pageOf = (col, opts, n, extra) => {
    st.pages += 1;
    return client.listPage(col, Object.assign({}, opts, extra || {}, { page: n }));
  };
  /** 全ページを読む(1ページ目 → 残りを並べて)。空のページが来たらそこで止める(元の listAll と同じ)。 */
  const allPages = (col, opts, extra) => pageOf(col, opts, 1, extra).then((r1) => {
    const first = (r1 && r1.items) || [];
    const total = Number(r1 && r1.totalPages) || 1;
    if (!first.length || total <= 1) return first.slice();
    const got = []; got[1] = first;
    const todo = [];
    for (let n = 2; n <= total; n++) todo.push(n);
    let at = 0;
    let bad = false;
    const worker = () => {
      if (bad || at >= todo.length) return Promise.resolve();
      const n = todo[at]; at += 1;
      return pageOf(col, opts, n, extra).then((r) => { got[n] = (r && r.items) || []; return worker(); }, (e) => { bad = true; throw e; });
    };
    const ws = [];
    for (let i = 0; i < Math.min(LIST_PARALLEL_PAGES, todo.length); i++) ws.push(worker());
    return Promise.all(ws).then(() => {
      const out = [];
      for (let n = 1; n <= total; n++) {
        const items = got[n] || [];
        if (!items.length) break;
        for (let i = 0; i < items.length; i++) out.push(items[i]);
      }
      return out;
    });
  });
  const hasStamp = (r) => !!r && typeof r.id === 'string' && typeof r.updated === 'string' && r.updated !== '';
  /** 前に全部読めた答え(prev)から、変わった物だけを読んで今の答えを作る。作れない時は null(全部読む)。 */
  const delta = (col, opts, prev) => {
    const m = WHOLE_COLLECTION_RE.exec(String(opts.filter || ''));
    const sameNsCol = (r) => !m || ((r.ns == null || r.ns === unq(m[1])) && (r.col == null || r.col === unq(m[2])));
    return deltaWith(col, opts, prev, sameNsCol);
  };
  const deltaWith = (col, opts, prev, sameNsCol) => allPages(col, opts, { fields: 'id,updated', perPage: LIST_IDS_PER_PAGE }).then((ids) => {
    if (!ids.every(hasStamp)) return null;
    const before = new Map();
    prev.forEach((r) => { before.set(r.id, r); });
    const changed = ids.filter((x) => { const p = before.get(x.id); return !p || p.updated !== x.updated; }).map((x) => x.id);
    if (changed.some((id) => !SAFE_ID_RE.test(id))) return null;
    if (!changed.length && !ids.length) return [];
    if (changed.length > Math.max(200, Math.floor(ids.length / 4))) return null;   // 変わった物が多い: 全部読む
    const chunks = [];
    for (let i = 0; i < changed.length; i += LIST_CHANGED_CHUNK) chunks.push(changed.slice(i, i + LIST_CHANGED_CHUNK));
    const fresh = new Map();
    let at = 0;
    const worker = () => {
      if (at >= chunks.length) return Promise.resolve();
      const ch = chunks[at]; at += 1;
      // ⚠番号だけで絞る(番号は上の一覧 = 同じ ns/col から来た物。ns/col も足すと PocketBase が全件を見直し約3倍遅い・実測)。
      //   読めた物の ns/col はここで確かめ、違えば使わない。
      const filter = ch.map((id) => `id="${id}"`).join(' || ');
      return allPages(col, Object.assign({}, opts, { filter: filter }), { perPage: LIST_CHANGED_CHUNK })
        .then((recs) => { recs.forEach((r) => { if (r && typeof r.id === 'string' && sameNsCol(r)) fresh.set(r.id, r); }); return worker(); });
    };
    const ws = [];
    for (let i = 0; i < Math.min(LIST_PARALLEL_PAGES, chunks.length); i++) ws.push(worker());
    return Promise.all(ws).then(() => {
      const out = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i].id;
        const now = fresh.get(id);
        if (now) { out.push(now); continue; }
        const p = before.get(id);
        if (p && p.updated === ids[i].updated) out.push(p);
        // 変わったのに読めなかった = その間に消えた(落とす)
      }
      st.changed += changed.length;
      return out;
    });
  });
  /** 全部読めた答えを覚える(古い物は押し出す)。 */
  const remember = (k, recs) => {
    last.delete(k); last.set(k, { recs: recs });
    if (last.size > LIST_REMEMBER_MAX) last.delete(last.keys().next().value);
  };

  const wrapped = function listAllShared(col, opts) {
    const o = opts || {};
    if (o.fields || o.page != null) return origListAll.apply(client, arguments);   // 項目を選ぶ・ページ指定の読みは今までどおり
    st.calls += 1;
    const k = `${col}\n${JSON.stringify(o)}`;
    const hit = inflight.get(k);
    if (hit) { st.shared += 1; return hit; }
    const whole = WHOLE_COLLECTION_RE.test(String(o.filter || ''));
    const prev = whole ? last.get(k) : null;
    const p = Promise.resolve()
      .then(() => (prev && prev.recs.length && prev.recs.every(hasStamp) ? delta(col, o, prev.recs) : null))
      .then((r) => {
        if (r) { st.delta += 1; return r; }
        if (prev) st.deltaFallback += 1;
        st.full += 1;
        // ⑤ 並びが決まっている読みは、1ページを広げて往復を減らす(答えの中身と並びは同じ)
        const per = Number(o.perPage) || 0;
        return allPages(col, o, o.sort && per < LIST_FULL_PER_PAGE ? { perPage: LIST_FULL_PER_PAGE } : null);
      })
      .then((recs) => {
        if (whole) remember(k, recs);
        return recs;
      });   // ⑤ 途中で切れた時は覚えない(次は全部をページで並べて読む)
    inflight.set(k, p);
    const done = () => { if (inflight.get(k) === p) inflight.delete(k); };
    p.then(done, done);
    return p;
  };
  client.listAll = wrapped;
  client[LIST_MARK] = true;
  return {
    undo: () => { if (client.listAll === wrapped) client.listAll = origListAll; delete client[LIST_MARK]; inflight.clear(); last.clear(); },
    stats: () => Object.assign({}, st),
  };
};

/**
 * 保管庫(PocketBase 版)に「購読が切れたら張り直しを助け、張り直せたら取りこぼしを読み直す」係を取り付ける。
 * ⚠同じ保管庫に2回取り付けない(2回目は1回目の係を返す)。
 * @param backend  createPocketbaseBackend の戻り(raw = pbClient・refresh・watch*・get* を持つ物)
 * @param opts.win     online の合図を出す物(window)
 * @param opts.host    fetch を持つ物(既定は 窓口の fetchHost → globalThis。pbClient は呼ぶ時にこれの fetch を引く)
 * @param opts.listAll 窓口の listAll を包む(③。既定 true)
 * @param opts.timers  { setTimeout, clearTimeout }(試験で差し替える)
 * @param opts.doc     visibilitychange の合図を出す物(document。前に出た時にすぐ見張る)
 * @param opts.now     今の時刻(ミリ秒)を返す関数(試験で差し替える)
 * @param opts.pingMs / pingTimeoutMs / idleMs  ④ 見張りの間隔・突く時の時間切れ・何も届かない流れを切るまで(0 で見張らない)
 * @returns 係 { isLive(), stats(), onOpen(cb), checkNow(), dispose() }
 */
export const installRealtimeResync = (backend, {
  win = (typeof window !== 'undefined' ? window : null),
  doc = (typeof document !== 'undefined' ? document : null),
  host = null,
  timers = null, firstMs = RESYNC_RETRY_FIRST_MS, maxMs = RESYNC_RETRY_MAX_MS,
  pingMs = REALTIME_PING_MS, pingTimeoutMs = REALTIME_PING_TIMEOUT_MS, idleMs = REALTIME_IDLE_MS,
  now = () => Date.now(),
  listAll = true,
} = {}) => {
  if (!backend || typeof backend !== 'object') return null;
  if (backend[MARK]) return backend[MARK];
  const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  const client = backend.raw || null;
  const base = client && typeof client.url === 'string' ? client.url : '';
  // ① 包む入れ物: 指定 → 窓口の fetchHost(最終: 札の係を通る道) → ブラウザ(globalThis)
  const fetchHost = host
    || (client && client.fetchHost && typeof client.fetchHost.fetch === 'function' ? client.fetchHost : null)
    || (typeof globalThis !== 'undefined' ? globalThis : null);
  let disposed = false;

  // --- 状態 ---------------------------------------------------------------------
  let opens = 0;           // 申し込みが通った回数
  let drops = 0;           // 流れが閉じた/切れた/開けなかった回数
  let kicks = 0;           // ④ 見張りが「黙って死んだ」と見て切った回数
  let pings = 0;           // ④ 見張りがサーバを突いた回数
  let pingFails = 0;       // ④ そのうち届かなかった回数
  let live = false;
  let resyncs = 0;         // 張り直せた後に読み直した回数(試験・画面の材料)
  const subs = new Map();  // "ns/col" -> 購読の数
  const seen = new Set();  // 読んだ事のある一覧(購読・1回だけ)
  const stale = new Set(); // 張り直した後、まだサーバから読み直していない一覧(購読していない物)
  const refreshing = new Map(); // "ns/col" -> 読み直しの最中に知らせが届いたか
  const staleErr = new Map();   // "ns/col" -> 張り直した後の読み直しが失敗した理由(読めたら消す)
  const openSubs = new Set();
  const streams = new Set();    // 今の流れ(online で切る)
  const waiters = new Set();    // 届かない間の待ち(online で起こす)

  const tellOpen = (info) => { openSubs.forEach((cb) => { try { cb(info); } catch (e) { console.error('[購読] 受け手で例外', e); } }); };
  const dropped = () => { if (live) live = false; drops += 1; };

  /** 1つの一覧をサーバから読み直す。最中に知らせが届いたら、もう1回だけ。 */
  const refreshKey = (k, left) => {
    const nc = splitKey(k);
    refreshing.set(k, false);
    return Promise.resolve()
      .then(() => backend.refresh(nc[0], nc[1]))
      .then(() => {
        const heard = refreshing.get(k);
        refreshing.delete(k);
        if (heard && left > 0 && !disposed) return refreshKey(k, left - 1);
        return null;
      }, (e) => {
        refreshing.delete(k);
        stale.add(k);   // 次に読まれた時にもう一度(読み直しの係が包んでいれば、ここで「読み直す物」にも入る)
        staleErr.set(k, e);
        console.warn(`[購読] 張り直した後、${k} を読み直せませんでした(次に読む時・つながった時にもう一度)`, e && e.message ? e.message : e);
      });
  };
  /** 張り直せた: 購読中の一覧は読み直す・それ以外は「古いかもしれない」印。 */
  const resync = () => {
    resyncs += 1;
    const jobs = [];
    seen.forEach((k) => {
      if ((subs.get(k) || 0) > 0) jobs.push(refreshKey(k, 1));
      else stale.add(k);
    });
    return Promise.all(jobs);
  };
  const opened = () => {
    const reconnect = opens > 0 || drops > 0;
    opens += 1; live = true;
    if (reconnect) resync();
    tellOpen({ reconnect: reconnect, opens: opens });
  };

  // --- 流れの中身を見る(そのまま渡しながら、知らせの置き場所を拾う) -----------------
  const noteEvents = (text) => {
    const re = /(^|\n)event:\s*([^\n]*)\ndata:\s*([^\n]*)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[2].trim() === 'PB_CONNECT') continue;
      try {
        const d = JSON.parse(m[3]);
        const r = d && d.record;
        if (r && r.ns != null && r.col != null) {
          const k = keyOf(r.ns, r.col);
          if (refreshing.has(k)) refreshing.set(k, true);
        }
      } catch { /* 形が違う知らせは見ない(pbClient がそのまま扱う) */ }
    }
  };
  // --- ④ 見張り(心拍): 流れが黙って死んだのを見つけて切る ------------------------------
  //   ⚠流れが開いている間だけ動く(流れが無い間は GET の待ち・online の合図が受け持つ)。
  //   ⚠突くのは /api/health(この係の受け手が見ない住所 = 素通し)。最終は札の係を通る(fetchHost)。
  let watchTimer = null;
  let pinging = false;
  const watchOn = () => !disposed && !!base && pingMs > 0;
  const armWatch = () => {
    if (!watchOn() || watchTimer != null || !streams.size) return;
    watchTimer = T.setTimeout(() => { watchTimer = null; check('timer'); }, pingMs);
    // Node(試験)で、見張りだけが残って終われなくならないように(ブラウザの番号には無い)
    if (watchTimer && typeof watchTimer.unref === 'function') watchTimer.unref();
  };
  const stopWatch = () => { if (watchTimer != null) { T.clearTimeout(watchTimer); watchTimer = null; } };
  const kickAll = (why) => { kicks += 1; [...streams].forEach((s) => s.kick(why)); };
  const ping = () => {
    const f = fetchHost && typeof fetchHost.fetch === 'function' ? fetchHost.fetch : null;
    if (!f) return Promise.resolve(true);
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timedOut = false;
    const h = T.setTimeout(() => { timedOut = true; if (ac) ac.abort(); }, pingTimeoutMs);
    if (h && typeof h.unref === 'function') h.unref();
    const done = (ok) => { T.clearTimeout(h); return ok; };
    return Promise.resolve()
      .then(() => f.call(fetchHost, `${base}/api/health`, Object.assign({ method: 'GET', cache: 'no-store' }, ac ? { signal: ac.signal } : {})))
      .then((res) => {
        try { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch { /* 読み捨て */ }
        return done(!timedOut && !!res && !isRetryableRealtimeStatus(res.status));
      }, () => done(false));
  };
  /** 見張りの1回: 何も届かない流れを切る・サーバへ届かなければ流れを切る。 */
  const check = () => {
    if (!watchOn()) return Promise.resolve();
    const t = now();
    const idle = [...streams].filter((s) => idleMs > 0 && t - s.lastAt > idleMs);
    if (idle.length) { kicks += 1; idle.forEach((s) => s.kick('購読の流れが黙ったままなので張り直します')); }
    if (!streams.size || pinging) { armWatch(); return Promise.resolve(); }
    pinging = true; pings += 1;
    return ping().then((ok) => {
      pinging = false;
      if (disposed) return;
      if (!ok) { pingFails += 1; if (streams.size) kickAll('サーバへ届かないので購読を張り直します'); }
      armWatch();
    });
  };
  const onVisible = () => { if (doc && doc.visibilityState === 'visible' && streams.size) { stopWatch(); check('visible'); } };

  const pipe = (res, realAbort) => {
    const reader = res.body.getReader();
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    let buf = '';
    let ctl = null;
    let ended = false;
    const end = () => { if (ended) return false; ended = true; streams.delete(entry); dropped(); return true; };
    const entry = {
      lastAt: now(),   // ④ 最後に何かが届いた時刻
      kick: (why) => {   // online・見張り: つながっているつもりの流れを切る(pbClient が張り直す)
        if (!end()) return;
        try { realAbort(); } catch { /* もう閉じている */ }
        try { ctl.error(new TypeError(why || '回線が変わったので購読を張り直します')); } catch { /* もう閉じている */ }
      },
    };
    streams.add(entry);
    armWatch();
    const body = new ReadableStream({
      start: (c) => { ctl = c; },
      pull: (c) => reader.read().then((r) => {
        if (ended) return;
        if (r.done) { end(); c.close(); return; }
        entry.lastAt = now();
        if (dec) {
          buf += dec.decode(r.value, { stream: true });
          const i = buf.lastIndexOf('\n\n');
          if (i >= 0) { noteEvents(buf.slice(0, i + 2)); buf = buf.slice(i + 2); }
        }
        c.enqueue(r.value);
      }, (e) => { if (end()) c.error(e); }),
      cancel: (why) => { end(); return reader.cancel(why); },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  // --- /api/realtime の受け手 ----------------------------------------------------
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    let h = null;
    const w = { wake: () => { cleanup(); resolve(); } };
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => { if (h != null) { T.clearTimeout(h); h = null; } waiters.delete(w); if (signal) signal.removeEventListener('abort', onAbort); };
    h = T.setTimeout(() => { cleanup(); resolve(); }, ms);
    waiters.add(w);
    if (signal) signal.addEventListener('abort', onAbort);
  });
  const onRealtime = (input, init, call) => {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (disposed) return call(input, init);
    if (method === 'POST') {
      return call(input, init).then((res) => { if (res && res.ok && !disposed) opened(); return res; });
    }
    if (method !== 'GET') return call(input, init);
    const outer = init && init.signal ? init.signal : null;
    let delay = firstMs;
    const tryOnce = () => {
      if (outer && outer.aborted) return Promise.reject(abortError());
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const onOuter = () => { if (ac) ac.abort(); };
      if (outer && ac) outer.addEventListener('abort', onOuter);
      const myInit = Object.assign({}, init || {}, ac ? { signal: ac.signal } : {});
      const retry = () => {
        dropped();
        // 届かない: ここで待って試し直す(pbClient の待ちを延ばさない・online ならすぐ)
        const ms = delay; delay = Math.min(maxMs, delay * 2);
        return sleep(ms, outer).then(tryOnce);
      };
      return call(input, myInit).then((res) => {
        if (res && res.ok && res.body) return pipe(res, () => { if (ac) ac.abort(); });
        // ② 入口の 502/503/504 など(PocketBase が落ちている間)は、届かない時と同じにここで試し直す
        if (res && isRetryableRealtimeStatus(res.status) && !disposed && !(outer && outer.aborted)) {
          if (outer && outer.removeEventListener) outer.removeEventListener('abort', onOuter);
          try { if (res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); } catch { /* 読み捨て */ }
          return retry();
        }
        dropped(); return res;   // 断られた(401・403 など)は pbClient へそのまま
      }, (e) => {
        if (outer && outer.removeEventListener) outer.removeEventListener('abort', onOuter);
        if (disposed || (outer && outer.aborted)) throw e;
        return retry();
      });
    };
    return tryOnce();
  };
  // この窓口の要求か: 送る札(Authorization)が、この窓口の今の札と同じ時だけ(別の窓口・別のログインの購読は見ない)
  //   ⚠札は延ばすと変わる(延ばす直前に組んだ要求は前の札)。この窓口が持った事のある札を少しだけ覚える。
  const tokens = [];
  const owns = (init) => {
    const tok = client && client.token;
    if (tok && tokens.indexOf(tok) < 0) { tokens.push(tok); if (tokens.length > 4) tokens.shift(); }
    const sent = headerOf(init, 'Authorization');
    return !!sent && tokens.indexOf(sent) >= 0;
  };
  const unhook = base ? hookFetch(fetchHost, `${base}/api/realtime`, { owns: owns, run: onRealtime }) : () => {};
  // ③ 一覧の読み(listAll)を包む
  const lister = listAll ? wrapListAll(client) : null;
  const unList = lister ? lister.undo : () => {};

  const onOnline = () => {
    if (disposed) return;
    [...waiters].forEach((w) => w.wake());
    [...streams].forEach((s) => s.kick());
  };
  // ⚠流れを見ていない(住所の無い保管庫)時は online を聞かない(切る物も起こす物も無い)
  if (base && win && typeof win.addEventListener === 'function') win.addEventListener('online', onOnline);
  if (watchOn() && doc && typeof doc.addEventListener === 'function') doc.addEventListener('visibilitychange', onVisible);

  // --- 読みの口を包む(購読の数・読んだ一覧・古いかもしれない一覧) ---------------------------
  const orig = {};
  const wrap = (name, fn) => { if (typeof backend[name] === 'function') { orig[name] = backend[name]; backend[name] = fn; } };
  const watching = (name) => function watchWithResync(ns, col) {
    const k = keyOf(ns, col);
    seen.add(k);
    subs.set(k, (subs.get(k) || 0) + 1);
    stale.delete(k);   // 購読は保管庫が今の姿を配る(読み直しが要る時は張り直しの時に読み直す)
    const un = orig[name].apply(backend, arguments);
    let done = false;
    return function unwatch() {
      if (!done) { done = true; const n = (subs.get(k) || 1) - 1; if (n > 0) subs.set(k, n); else subs.delete(k); }
      return typeof un === 'function' ? un.apply(this, arguments) : undefined;
    };
  };
  // 読み直し(refresh)が通ったら「古いかもしれない」印を下ろす(読み直しの係の読み直しで通った時も)
  wrap('refresh', function refreshWithResync(ns, col) {
    const k = keyOf(ns, col);
    return Promise.resolve().then(() => orig.refresh.apply(backend, arguments))
      .then((n) => { stale.delete(k); staleErr.delete(k); return n; });
  });
  wrap('watchCollection', watching('watchCollection'));
  wrap('watchDoc', watching('watchDoc'));
  wrap('watchQuery', watching('watchQuery'));
  ['getAll', 'getOne', 'getPage', 'getPageFields', 'countQuery'].forEach((m) => {
    wrap(m, function readWithResync(ns, col) {
      const k = keyOf(ns, col);
      seen.add(k);
      const args = arguments;
      if (!stale.has(k) || (subs.get(k) || 0) > 0) return orig[m].apply(backend, args);
      // 張り直した後、まだ読み直していない: サーバから読み直してから返す(読めなければ今までどおり控え)
      return refreshKey(k, 0).then(() => orig[m].apply(backend, args));
    });
  });

  const ctl = {
    isLive: () => live,
    /** 張り直した後、その一覧をサーバから読み直せていない理由(読めていれば null)。 */
    errorOf: (ns, col) => staleErr.get(keyOf(ns, col)) || null,
    stats: () => ({ opens: opens, drops: drops, resyncs: resyncs, kicks: kicks, pings: pings, pingFails: pingFails, stale: [...stale], subscribed: [...subs.keys()], lists: lister ? lister.stats() : null }),
    /** ④ 見張りを今すぐ1回動かす(試験・画面の「今すぐ確かめる」)。 */
    checkNow: () => { stopWatch(); return check('manual'); },
    /** 購読が開いた(張り直せた)合図: cb({ reconnect, opens })。戻り値は外す関数。 */
    onOpen: (cb) => { openSubs.add(cb); return () => { openSubs.delete(cb); }; },
    dispose: () => {
      disposed = true;
      unhook();
      unList();
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('online', onOnline);
      if (doc && typeof doc.removeEventListener === 'function') doc.removeEventListener('visibilitychange', onVisible);
      stopWatch();
      [...waiters].forEach((w) => w.wake());
      Object.keys(orig).forEach((m) => { backend[m] = orig[m]; });
      delete backend[MARK];
    },
  };
  backend[MARK] = ctl;
  return ctl;
};
