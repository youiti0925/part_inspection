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

/** 流れを開けない間の、ここでの試し直しの間隔(ミリ秒)。 */
export const RESYNC_RETRY_FIRST_MS = 500;
export const RESYNC_RETRY_MAX_MS = 10000;

const MARK = '__inspectionRealtimeResync';
const FETCH_MARK = '__inspectionRealtimeFetch';
const keyOf = (ns, col) => `${ns}/${col}`;
const splitKey = (k) => { const i = k.indexOf('/'); return [k.slice(0, i), k.slice(i + 1)]; };
const abortError = () => { const e = new Error('The operation was aborted.'); e.name = 'AbortError'; return e; };

/**
 * ブラウザの fetch を1回だけ包み、住所ごとの受け手へ回す(受け手が無い要求は素通し)。
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
      const h = reg.handlers.get(u);
      if (h) return h(input, init, (a, b) => reg.orig.call(host, a, b));
      return reg.orig.apply(host, arguments);
    };
    wrapped[FETCH_MARK] = reg;
    host.fetch = wrapped;
  }
  reg.handlers.set(url, handler);
  return () => {
    if (reg.handlers.get(url) === handler) reg.handlers.delete(url);
    if (!reg.handlers.size && host.fetch && host.fetch[FETCH_MARK] === reg) host.fetch = reg.orig;
  };
};

/**
 * 保管庫(PocketBase 版)に「購読が切れたら張り直しを助け、張り直せたら取りこぼしを読み直す」係を取り付ける。
 * ⚠同じ保管庫に2回取り付けない(2回目は1回目の係を返す)。
 * @param backend  createPocketbaseBackend の戻り(raw = pbClient・refresh・watch*・get* を持つ物)
 * @param opts.win     online の合図を出す物(window)
 * @param opts.host    fetch を持つ物(既定は globalThis。pbClient は呼ぶ時にこれの fetch を引く)
 * @param opts.timers  { setTimeout, clearTimeout }(試験で差し替える)
 * @returns 係 { isLive(), stats(), onOpen(cb), dispose() }
 */
export const installRealtimeResync = (backend, {
  win = (typeof window !== 'undefined' ? window : null),
  host = (typeof globalThis !== 'undefined' ? globalThis : null),
  timers = null, firstMs = RESYNC_RETRY_FIRST_MS, maxMs = RESYNC_RETRY_MAX_MS,
} = {}) => {
  if (!backend || typeof backend !== 'object') return null;
  if (backend[MARK]) return backend[MARK];
  const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  const client = backend.raw || null;
  const base = client && typeof client.url === 'string' ? client.url : '';
  let disposed = false;

  // --- 状態 ---------------------------------------------------------------------
  let opens = 0;           // 申し込みが通った回数
  let drops = 0;           // 流れが閉じた/切れた/開けなかった回数
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
      } catch (e) { /* 形が違う知らせは見ない(pbClient がそのまま扱う) */ }
    }
  };
  const pipe = (res, realAbort) => {
    const reader = res.body.getReader();
    const dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    let buf = '';
    let ctl = null;
    let ended = false;
    const end = () => { if (ended) return false; ended = true; streams.delete(entry); dropped(); return true; };
    const entry = {
      kick: () => {   // online: つながっているつもりの流れを切る(pbClient が張り直す)
        if (!end()) return;
        try { realAbort(); } catch (e) { /* もう閉じている */ }
        try { ctl.error(new TypeError('回線が変わったので購読を張り直します')); } catch (e) { /* もう閉じている */ }
      },
    };
    streams.add(entry);
    const body = new ReadableStream({
      start: (c) => { ctl = c; },
      pull: (c) => reader.read().then((r) => {
        if (ended) return;
        if (r.done) { end(); c.close(); return; }
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
      return call(input, myInit).then((res) => {
        if (!res || !res.ok || !res.body) { dropped(); return res; }   // 断られた(401 など)は pbClient へそのまま
        return pipe(res, () => { if (ac) ac.abort(); });
      }, (e) => {
        if (outer && outer.removeEventListener) outer.removeEventListener('abort', onOuter);
        if (disposed || (outer && outer.aborted)) throw e;
        dropped();
        // 届かない: ここで待って試し直す(pbClient の待ちを延ばさない・online ならすぐ)
        const ms = delay; delay = Math.min(maxMs, delay * 2);
        return sleep(ms, outer).then(tryOnce);
      });
    };
    return tryOnce();
  };
  const unhook = base ? hookFetch(host, `${base}/api/realtime`, onRealtime) : () => {};

  const onOnline = () => {
    if (disposed) return;
    [...waiters].forEach((w) => w.wake());
    [...streams].forEach((s) => s.kick());
  };
  // ⚠流れを見ていない(住所の無い保管庫)時は online を聞かない(切る物も起こす物も無い)
  if (base && win && typeof win.addEventListener === 'function') win.addEventListener('online', onOnline);

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
    stats: () => ({ opens: opens, drops: drops, resyncs: resyncs, stale: [...stale], subscribed: [...subs.keys()] }),
    /** 購読が開いた(張り直せた)合図: cb({ reconnect, opens })。戻り値は外す関数。 */
    onOpen: (cb) => { openSubs.add(cb); return () => { openSubs.delete(cb); }; },
    dispose: () => {
      disposed = true;
      unhook();
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('online', onOnline);
      [...waiters].forEach((w) => w.wake());
      Object.keys(orig).forEach((m) => { backend[m] = orig[m]; });
      delete backend[MARK];
    },
  };
  backend[MARK] = ctl;
  return ctl;
};
