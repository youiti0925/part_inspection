// ============================================================================
// 🔁 社内版(PocketBase): 届かない間に読めなかった一覧を、つながったら全部読み直す(R39 の残り・2026-10-31)
// ----------------------------------------------------------------------------
// 何が困っていたか:
//   サーバに届かない間に開いた画面の一覧(製品の logs・年間目標の設定・最終/部品の設定とロット、
//   最終の lot_images、部品の plan_control など)は、読めなかった時に console へ出るだけで、
//   **つながった後も誰も読み直さなかった**(帯も出ず、画面は黙って空・古いまま)。
//   画面ごとに読み直しを足すと、足し忘れた一覧がまた残る。→ 保管庫の層で1か所にする。
// 形:
//   ① 保管庫(pocketbaseBackend)の読みの口(watchCollection / watchDoc / watchQuery / getAll / getOne /
//      getPage / getPageFields / countQuery)を包み、**通信の失敗で読めなかった一覧** を「読み直す物」に登録する。
//      ⚠包むのは保管庫の入れ物そのもの(窓口 provider.js は呼ぶたびに backends[...] から引くので、
//        DATA(db) でも製品の OPS(db) でも、同じ保管庫を通る読みは全部ここを通る)。
//   ② つながった合図で、登録した物を全部読み直す。合図 = ブラウザの online・サーバへの要求が1つでも通った時
//      (購読の張り直し・他の一覧の読み・送信待ちの箱の送信)・それ以外は間隔を空けながら(既定 2秒→4秒→…→30秒)。
//      読めるまで続ける。読めた一覧は保管庫が購読の受け手へ「サーバの答え」を配る(画面の購読は張り直さない)。
//   ③ まだ読めていない一覧の名前を、画面が知れるようにする(subscribe)。画面はその間、穏やかな帯を出す(黙らない)。
//      1回だけ読む画面(getAll など)は、読み直せた合図(onRecovered)で自分の読みをやり直す。
// ⚠社内版のビルドだけが使う(いつものビルドでは、使う所がビルドの時の定数で畳まれ、出力に入らない)。
// ⚠DOM も firebase も import しない(Node の試験で読めるように)。4アプリで同じ中身。
// ⚠権限・ログイン・形の誤りは登録しない(何度読んでも同じ。今までどおり各画面の赤い帯・console)。
// ⚠ログインできていない間は読み直さない(PocketBase は未ログインの一覧に 200 + 0件を返す。
//   それを「読めた」にすると画面が空で確定してしまう)。
// ⚠⚠書き方の決まり: { ...x } ・ async/await ・ ?. ・ ?? を使わない。ビルドの対象(es2015/safari11)では
//   これらが補助の部品(objectSpread2・asyncToGenerator)に置き換わり、その部品の呼び出しが
//   **いつものビルドの出力にも残る**(このファイル自体は畳まれて消えても)。2026-10-31 実測(部品の dist の md5 が変わった)。
// ============================================================================

// 🔁 2026-10-31 購読(SSE)が切れた後の張り直しの手伝いと、切れていた間の取りこぼしの読み直し(同じく社内版だけ・4アプリ同じ中身)
import { installRealtimeResync } from './realtimeResync.js';

/** 読み直しの間隔(ミリ秒): 最初 → 倍々 → 上限。 */
export const READ_RETRY_FIRST_MS = 2000;
export const READ_RETRY_MAX_MS = 30000;

// 「つながらない」と言える理由。PocketBase の窓口(pbClient)の通信失敗・入口の 502/503/504・ブラウザの fetch 失敗。
const NET_RE = /PocketBase 通信失敗|PocketBase 50[234]\b|Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT/i;

/** 読めなかった理由が「サーバにつながらない」(=つながれば読める)か。 */
export const isRetryableReadError = (e) => {
  if (e == null) return false;
  if (typeof e === 'object') {
    if (e.name === 'PbNetworkError') return true;
    const st = Number(e.status);
    if (st === 502 || st === 503 || st === 504) return true;
    return NET_RE.test(String(e.code || '')) || NET_RE.test(String(e.message || ''));
  }
  return NET_RE.test(String(e));
};

// ⚠Symbol.for(…) などの呼び出しを最上段に置かない(呼び出しがあると、いつものビルドでもこのファイルが出力に残る)。
const MARK = '__inspectionReadRetry';
const keyOf = (ns, col) => `${ns}/${col}`;
const serverSnap = (snap) => !!(snap && snap.metadata && snap.metadata.fromCache === false);

/**
 * 保管庫(PocketBase 版)に「読めなかった一覧を、つながったら読み直す」係を取り付ける。
 * ⚠同じ保管庫に2回取り付けない(2回目は1回目の係を返す)。
 * @param backend  createPocketbaseBackend の戻り(refresh・loadErrorOf・raw を持つ物)
 * @param opts.win     window(online の合図)。無ければ間隔だけ
 * @param opts.timers  { setTimeout, clearTimeout }(試験で差し替える)
 * @returns 係 { unread(), subscribe(cb), onRecovered(cb), retryNow(why), dispose() }
 */
export const installReadRetry = (backend, {
  win = (typeof window !== 'undefined' ? window : null), timers = null,
  firstMs = READ_RETRY_FIRST_MS, maxMs = READ_RETRY_MAX_MS,
  // ⚠fetchHost の既定は null(購読の係が 窓口の fetchHost → globalThis の順に選ぶ。最終は札の係を通る入れ物)
  fetchHost = null, resyncTimers = null,
} = {}) => {
  if (!backend || typeof backend !== 'object') return null;
  if (backend[MARK]) return backend[MARK];
  // 🔁 購読の張り直しの係を先に付ける(この係の包みが内側。読み直し refresh はこの係の包みも通る)
  const resync = installRealtimeResync(backend, { win, host: fetchHost, timers: resyncTimers });
  const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  const client = backend.raw || null;

  const failed = new Map();        // "ns/col" -> { ns, col, error, since, tries }
  const subs = new Set();          // 画面: 読めていない一覧が変わった
  const recoveredSubs = new Set(); // 画面: 読み直せた(1回だけ読む画面がやり直す合図)
  let timer = null;
  let delay = firstMs;
  let busy = false;
  let again = false;
  let disposed = false;

  const unread = () => [...failed.values()].map((f) => ({ key: keyOf(f.ns, f.col), ns: f.ns, col: f.col, error: f.error, since: f.since, tries: f.tries }));
  const tell = () => { const list = unread(); subs.forEach((cb) => { try { cb(list); } catch (e) { console.error('[読み直し] 受け手で例外', e); } }); };
  const tellRecovered = (keys) => { recoveredSubs.forEach((cb) => { try { cb(keys); } catch (e) { console.error('[読み直し] 受け手で例外', e); } }); };

  const clearTimer = () => { if (timer != null) { T.clearTimeout(timer); timer = null; } };
  const schedule = (ms) => {
    clearTimer();
    if (disposed || !failed.size) return;
    timer = T.setTimeout(() => { timer = null; attempt('backoff'); }, ms);
  };

  /** 読めなかった一覧を登録する(通信の失敗だけ)。
   *  viaRefresh = サーバからの読み直し(refresh)が届かなかった。その一覧は手元に前の控えがあり、getAll や購読の最初の知らせは
   *  その控えを「サーバから読めた物(fromCache:false)」として返すので、それでは下ろさない(読み直しが通った時だけ下ろす)。 */
  const note = (ns, col, error, viaRefresh) => {
    if (disposed || !isRetryableReadError(error)) return;
    const k = keyOf(ns, col);
    const had = failed.get(k);
    failed.set(k, { ns, col, error, since: had ? had.since : Date.now(), tries: had ? had.tries : 0, needsRefresh: !!viaRefresh || !!(had && had.needsRefresh) });
    if (!had) { tell(); if (timer == null && !busy) schedule(delay); }
  };
  /** サーバから読めた(他の道で読めた時も)。viaRefresh = サーバからの読み直し(refresh)が通った。 */
  const ok = (ns, col, viaRefresh) => {
    const k = keyOf(ns, col);
    const f = failed.get(k);
    if (!f) return;
    // ⚠読み直しが届かなかった一覧は、手元の控えを返しただけの読み(getAll・購読の最初の知らせ)では下ろさない
    if (f.needsRefresh && !viaRefresh) return;
    failed.delete(k);
    tell();
    tellRecovered([k]);
    if (!failed.size) { clearTimer(); delay = firstMs; }
  };

  const loggedOut = () => typeof (client && client.isAuthed) === 'function' && !client.isAuthed();

  /** 登録した物を全部読み直す。⚠前の読み直しが終わるまで重ねない。 */
  const attempt = (why) => {
    if (disposed || !failed.size) return Promise.resolve();
    if (busy) { again = true; return Promise.resolve(); }
    busy = true; again = false;
    clearTimer();
    const got = [];
    const ready = (client && typeof client.whenReady === 'function')
      ? Promise.resolve().then(() => client.whenReady()).then(() => null, () => null)   // 失敗の中身は下(loggedOut)で分かる
      : Promise.resolve(null);
    return ready
      .then(() => {
        if (loggedOut()) return null;
        return Promise.all([...failed.values()].map((f) => {
          f.tries += 1;
          // ⚠読めたら保管庫が購読の受け手へサーバの答えを配る
          return Promise.resolve().then(() => backend.refresh(f.ns, f.col))
            .then(() => { got.push(keyOf(f.ns, f.col)); }, (e) => { f.error = e; });
        }));
      })
      .then(() => { busy = false; settle(got, why); }, (e) => { busy = false; console.warn('[読み直し] 失敗しました(次の機会にもう一度)', e); settle(got, why); });
  };
  /** 読み直しの後: 読めた物を下ろし、残りがあれば次を決める。 */
  const settle = (got, why) => {
    if (disposed) return;
    // ⚠読めた時、保管庫が配った「サーバの答え」で受け口(wrapCb)が先に下ろしている事がある。二重に知らせない。
    const still = got.filter((k) => failed.has(k));
    if (still.length) {
      still.forEach((k) => failed.delete(k));
      tell();
      tellRecovered(still);
    }
    if (!failed.size) { delay = firstMs; clearTimer(); return; }
    if (again || (got.length && why !== 'again')) { again = false; attempt('again'); return; }   // 読めた物があった = つながっている
    delay = Math.min(maxMs, Math.max(firstMs, delay * 2));
    schedule(delay);
  };
  /** つながった合図: 間隔を最初に戻して、すぐ読み直す。 */
  const reached = (why) => {
    if (disposed || !failed.size) return;
    delay = firstMs;
    if (busy) return;   // ⚠自分の読み直しの要求で、自分をもう一度呼ばない
    attempt(why);
  };

  // --- サーバへの要求が1つでも通った = つながった ---------------------------------
  const tapped = [];
  if (client) {
    for (const m of ['listPage', 'getOne', 'create', 'update', 'remove']) {
      const orig = client[m];
      if (typeof orig !== 'function') continue;
      client[m] = function tappedRequest(...args) {
        const r = orig.apply(this, args);
        if (r && typeof r.then === 'function') r.then(() => { if (!busy) reached('request'); }, () => {});
        return r;
      };
      tapped.push([m, orig]);
    }
  }
  const onOnline = () => reached('online');
  if (win && typeof win.addEventListener === 'function') win.addEventListener('online', onOnline);

  // --- 読みの口を包む ----------------------------------------------------------------
  const orig = {};
  const wrapErr = (ns, col, opts) => Object.assign({}, opts || {}, {
    // 📴 2026-11-02 保管庫が端末の控えを出せた「届かない」は、画面には知らせず(前の中身で動く)読み直しにだけ登録する
    onOfflineCache: (e) => { note(ns, col, e); },
    onError: (e) => {
      note(ns, col, e);
      if (opts && typeof opts.onError === 'function') opts.onError(e);
      else console.error(`[pb] ${keyOf(ns, col)} を読めませんでした`, e);
    },
  });
  const wrapCb = (ns, col, cb) => (a, snap) => { if (serverSnap(snap)) ok(ns, col); return cb(a, snap); };
  const afterOnce = (ns, col) => {
    // ⚠張り直した後の読み直しが届かずに失敗した一覧は、手元に古い控えがあっても「読めた」にしない
    const e = (typeof backend.loadErrorOf === 'function' ? backend.loadErrorOf(ns, col) : null) || (resync ? resync.errorOf(ns, col) : null);
    if (e) note(ns, col, e); else ok(ns, col);
  };
  const wrap = (name, fn) => { if (typeof backend[name] === 'function') { orig[name] = backend[name]; backend[name] = fn; } };

  wrap('watchCollection', (ns, col, cb, opts) => orig.watchCollection(ns, col, wrapCb(ns, col, cb), wrapErr(ns, col, opts)));
  wrap('watchDoc', (ns, col, id, cb, opts) => orig.watchDoc(ns, col, id, wrapCb(ns, col, cb), wrapErr(ns, col, opts)));
  wrap('watchQuery', (ns, col, spec, cb, opts) => orig.watchQuery(ns, col, spec, wrapCb(ns, col, cb), wrapErr(ns, col, opts)));
  for (const m of ['getAll', 'getOne', 'getPage', 'getPageFields']) {
    wrap(m, (ns, col, ...rest) => Promise.resolve(orig[m](ns, col, ...rest)).then((r) => { afterOnce(ns, col); return r; }));
  }
  wrap('countQuery', (ns, col, ...rest) => Promise.resolve().then(() => orig.countQuery(ns, col, ...rest))
    .then((n) => { ok(ns, col); return n; }, (e) => { note(ns, col, e); throw e; }));
  // 🔁 2026-10-31 読み直し(refresh)も包む: 購読を張り直した後の読み直しが届かずに失敗した一覧も「読み直す物」に入る(読めたら下ろす)。
  //   🔁 2026-10-31 verify14: ③の「更新」は購読中の一覧を refresh で読み直す。届かなかった時に登録しても、続く getAll が
  //   手元の控えを返して ok() で下ろしてしまい、帯が一瞬も残らなかった → refresh の失敗は refresh が通るまで下ろさない。
  wrap('refresh', (ns, col, ...rest) => Promise.resolve().then(() => orig.refresh(ns, col, ...rest))
    .then((n) => { ok(ns, col, true); return n; }, (e) => { note(ns, col, e, true); throw e; }));
  // 🔁 2026-10-31 購読が開いた(張り直せた) = サーバへ届いた。読めていない物があれば、すぐ読み直す。
  const offOpen = resync ? resync.onOpen(() => reached('realtime')) : null;

  const ctl = {
    unread,
    /** 読めていない一覧が変わったら cb(list)。すぐ1回呼ぶ。戻り値は外す関数。 */
    subscribe: (cb) => { subs.add(cb); try { cb(unread()); } catch (e) { console.error(e); } return () => { subs.delete(cb); }; },
    /** 読み直せたら cb(keys)。戻り値は外す関数。 */
    onRecovered: (cb) => { recoveredSubs.add(cb); return () => { recoveredSubs.delete(cb); }; },
    retryNow: (why = 'manual') => reached(why),
    /** 購読(SSE)の張り直しの係(isLive・stats)。 */
    resync,
    dispose: () => {
      disposed = true; clearTimer();
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('online', onOnline);
      for (const [m, f] of tapped) client[m] = f;
      for (const [m, f] of Object.entries(orig)) backend[m] = f;
      if (offOpen) offOpen();
      if (resync) resync.dispose();
      delete backend[MARK];
    },
  };
  backend[MARK] = ctl;
  return ctl;
};

/** 窓口(provider)が持つ PocketBase の保管庫に係を取り付け、係を返す(無ければ null)。窓口はそのまま使える。 */
export const readRetryOfProvider = (provider, opts) => {
  const be = provider && provider.backends && provider.backends.pocketbase;
  return be ? installReadRetry(be, opts) : null;
};

/** 画面に出す名前。自分のアプリの一覧はコレクション名だけ、他の置き場所は「置き場所/コレクション」。 */
export const unreadLabel = (u, appNs) => (u && u.ns === appNs ? String(u.col) : `${u && u.ns}/${u && u.col}`);
