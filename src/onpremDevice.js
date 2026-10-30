// ============================================================================
// 社内サーバ版(オンプレ)の「端末ごとのログイン」と「守った写真の札」— 2026-10-30
// ----------------------------------------------------------------------------
// 約束(サーバー側の担当が書いた物): C:\Users\anrw3\tmp-onprem-e2e\CONTRACT_device_login.md
//   ・合言葉は onprem-config.json から来ない(入口がいつも外す)。最初の1回だけ画面で入れる。
//   ・端末に覚えるのは **札(token)だけ**(localStorage の onprem.deviceSession.v1)。合言葉は覚えない。
//   ・開いた時・6時間ごと・画面が前に出た時に auth-refresh で札を延ばす。止めた端末(disabled)は延ばせない → ログインの画面へ。
//   ・写真(blobs.file)は protected。POST /api/files/token の「写真の札」(1時間)を 30 分ごとに取り直し、
//     表示する時だけ URL に ?token= を付ける(書類に保存する URL には付けない)。
//
// ⚠ このファイルは 社内版のビルド(IS_ONPREM_BUILD)の時だけ呼ばれる(src/onpremGate.js・App の起動の所)。
//   いつものビルドでは呼ばれないので出力から消える(本番の動きは1つも変わらない)。
// ⚠ 何も import しない(React も DOM も firebase も)。node の試験で読めるように・そして いつものビルドの出力を1バイトも変えない為
//   (import のある部品を App から読むと、使われなくても「部品を起こす」呼び出しが本番の出力に残る・実測 2026-10-30)。
//   DOM を触る installFileTokenLayer も、呼ばれた時だけ window を使う。
// ============================================================================

export const DEVICE_SESSION_KEY = 'onprem.deviceSession.v1';
/** 前の版が email と合言葉を覚えていた所(§2.4 で読んだら消す)。 */
export const LEGACY_DEVICE_KEY = 'onprem.device.v1';
/** 前の形の onprem-config.json(email / password 入り)を1回だけ使った印(中身は email だけ・合言葉は書かない)。 */
export const CONFIG_CREDS_USED_KEY = 'onprem.configCredsUsed.v1';
export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const FILE_TOKEN_INTERVAL_MS = 30 * 60 * 1000;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const sGet = (storage, key) => { try { return storage ? storage.getItem(key) : null; } catch { return null; } };
const sSet = (storage, key, val) => { try { if (!storage) return false; storage.setItem(key, val); return true; } catch { return false; } };
const sDel = (storage, key) => { try { if (storage) storage.removeItem(key); return true; } catch { return false; } };

// ---- 端末に覚える物 --------------------------------------------------------

/** 覚えた札を読む。形が違えば null(壊れた物で入ろうとしない)。 */
export const readDeviceSession = (storage) => {
  try {
    const v = JSON.parse(sGet(storage, DEVICE_SESSION_KEY) || 'null');
    return (v && typeof v === 'object' && v.v === 1 && typeof v.token === 'string' && v.token) ? v : null;
  } catch { return null; }
};

/** 覚える形(⚠合言葉の欄は作らない。渡されても入れない)。 */
export const makeSessionRecord = ({ collection = 'device_users', token, record, nowMs = Date.now(), savedAt } = {}) => {
  const iso = new Date(nowMs).toISOString();
  const r = (record && typeof record === 'object') ? record : {};
  return {
    v: 1, collection: str(collection) || 'device_users', token: String(token || ''), recordId: str(r.id),
    email: str(r.email), label: str(r.label), savedAt: savedAt || iso, refreshedAt: iso,
  };
};

export const writeDeviceSession = (storage, s) => sSet(storage, DEVICE_SESSION_KEY, JSON.stringify(makeSessionRecord({
  collection: s.collection, token: s.token, record: { id: s.recordId, email: s.email, label: s.label },
  nowMs: Date.parse(s.refreshedAt) || Date.now(), savedAt: s.savedAt,
})));
export const clearDeviceSession = (storage) => sDel(storage, DEVICE_SESSION_KEY);

/** 前の版の { email, password }。無ければ null。 */
export const readLegacyDevice = (storage) => {
  try {
    const v = JSON.parse(sGet(storage, LEGACY_DEVICE_KEY) || 'null');
    if (!v || typeof v !== 'object') return null;
    const email = str(v.email); const password = typeof v.password === 'string' ? v.password : '';
    return (email && password) ? { email, password } : null;
  } catch { return null; }
};
export const clearLegacyDevice = (storage) => sDel(storage, LEGACY_DEVICE_KEY);

// ---- 画面の文言・ファイルから読む -------------------------------------------

/** ログインの失敗の文言(約束 §2.2)。止めた端末も 400(PB は理由を返さない)。 */
export const loginErrorMessage = (status) => {
  if (status === 400) return 'メールアドレスか合言葉が違います';
  if (status === 429) return '何度も失敗したので少し待ってください';
  return `社内サーバーにつながりません(${status || '通信できません'})`;
};

/** 「ファイルから読む」: device-login.json か PC ごとの onprem-config.json から email と合言葉を取り出す(覚えない)。 */
export const credentialsFromLoginFile = (json) => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { ok: false, message: 'JSON のオブジェクトではありません' };
  const email = str(json.email);
  const password = typeof json.password === 'string' ? json.password : '';
  if (!email || !password) {
    return { ok: false, message: 'このファイルにはメールアドレスと合言葉がありません(device-login.json か、PC ごとの onprem-config.json を選んでください)' };
  }
  return { ok: true, email, password, label: str(json.label) || str(json.deviceLabel), collection: str(json.collection) || str(json.authCollection) };
};

// ---- 写真の URL に札を付ける -------------------------------------------------

/** 札を付けてよい口(origin)か。⚠よその口へ写真の札を渡さない。
 *  allowedOrigins を渡さなければ約束の形(住所なし /api/files/… と http(s)://どこか/api/files/…)。 */
export const isPbFileUrl = (url, allowedOrigins = null) => {
  const s = String(url || '');
  const m = /^(https?:\/\/[^/?#]+)?\/api\/files\//i.exec(s);
  if (!m) return false;
  if (/^\/api\/files\/token(?:[?#]|$)/i.test(s.replace(/^https?:\/\/[^/?#]+/i, ''))) return false;
  if (!m[1] || !allowedOrigins) return true;
  return allowedOrigins.map((o) => String(o).toLowerCase()).includes(m[1].toLowerCase());
};

/** 表示する時だけ ?token= を付ける(約束 §3)。既に token= があれば今の札に替える。data: / blob: / 他の URL はそのまま。 */
export const withFileToken = (url, fileToken, allowedOrigins = null) => {
  if (!url || !fileToken || typeof url !== 'string') return url;
  if (!isPbFileUrl(url, allowedOrigins)) return url;
  const hashAt = url.indexOf('#');
  const head = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const enc = encodeURIComponent(fileToken);
  if (/[?&]token=/.test(head)) return head.replace(/([?&])token=[^&]*/, `$1token=${enc}`) + hash;
  return `${head}${head.includes('?') ? '&' : '?'}token=${enc}${hash}`;
};

/** CSS の url(...) の中の写真の URL に札を付ける(背景の絵)。 */
export const rewriteCssUrls = (css, fileToken, allowedOrigins = null) => {
  if (typeof css !== 'string' || !fileToken || css.indexOf('/api/files/') < 0) return css;
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (all, q, u) => (isPbFileUrl(u, allowedOrigins) ? `url(${q}${withFileToken(u, fileToken, allowedOrigins)}${q})` : all));
};

/** 印刷の窓などへ document.write する HTML の中の src / href / poster / url(...) に札を付ける。 */
export const rewriteHtmlFileUrls = (html, fileToken, allowedOrigins = null) => {
  if (typeof html !== 'string' || !fileToken || html.indexOf('/api/files/') < 0) return html;
  const a = html.replace(/(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi,
    (all, pre, q, u) => (isPbFileUrl(u, allowedOrigins) ? `${pre}${q}${withFileToken(u, fileToken, allowedOrigins)}${q}` : all));
  return rewriteCssUrls(a, fileToken, allowedOrigins);
};

// ---- 札の持ち手 --------------------------------------------------------------

/**
 * 端末のログインの札と写真の札を持つ。
 * @param baseUrl      PocketBase の住所(onprem-config.json の url か同じ口)
 * @param collection   端末用の auth コレクション(既定 device_users)
 * @param fetchImpl    試験で差し替える
 * @param storage      localStorage(試験では入れ物)
 * @param configCreds  前の形の onprem-config.json の { email, password }(あれば1回だけ使う・約束 §2.4 と同じ考え)
 */
export const createDeviceSession = ({ baseUrl, collection = 'device_users', fetchImpl, storage, now = () => Date.now(), configCreds = null } = {}) => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const f = fetchImpl || ((...a) => fetch(...a));
  const col = encodeURIComponent(str(collection) || 'device_users');
  let state = readDeviceSession(storage);
  let fileTok = null;
  let fileTokAt = 0;
  let fileTokPending = null;
  let unauthPending = null;
  const listeners = new Set();
  const emit = (ev, detail) => { for (const fn of listeners) { try { fn(ev, detail); } catch { /* 聞き手の失敗で止めない */ } } };

  // ⚠ このファイルでは async / await を書かない(古い Safari 向けの変換で「async の助け」を起こす呼び出しになり、
  //   使われなくても いつものビルドの出力に残る・実測 2026-10-30)。Promise の then で書く。
  const post = (path, { body, token } = {}) => {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = token;
    return Promise.resolve()
      .then(() => f(`${base}${path}`, { method: 'POST', headers, cache: 'no-store', body: body === undefined ? undefined : JSON.stringify(body) }))
      .then((res) => Promise.resolve().then(() => res.json()).catch(() => null)
        .then((json) => ({ ok: !!res.ok, status: res.status, json })),
      (e) => ({ ok: false, status: 0, network: true, error: e }));
  };

  const adopt = (json, keepSavedAt) => {
    state = makeSessionRecord({ collection: str(collection) || 'device_users', token: json.token, record: json.record, nowMs: now(), savedAt: keepSavedAt });
    writeDeviceSession(storage, state);
    emit('token', state.token);
  };

  const logout = (reason = 'logout') => {
    state = null; fileTok = null; fileTokAt = 0;
    clearDeviceSession(storage);
    emit('loggedOut', reason);
  };

  const login = (email, password) => post(`/api/collections/${col}/auth-with-password`, { body: { identity: str(email), password: String(password || '') } })
    .then((r) => {
      if (r.ok && r.json && typeof r.json.token === 'string' && r.json.token) {
        adopt(r.json);
        fileTok = null; fileTokAt = 0;
        return { ok: true, status: r.status };
      }
      return { ok: false, status: r.status, message: loginErrorMessage(r.status) };
    });

  /** 札を延ばす。invalid=true は「もう使えない」(止めた・期限切れ・合言葉を替えた)。通信できない・5xx は札を残す。 */
  const refresh = () => {
    if (!state) return Promise.resolve({ ok: false, status: 401, invalid: true });
    return post(`/api/collections/${col}/auth-refresh`, { token: state.token }).then((r) => {
      if (r.ok && r.json && typeof r.json.token === 'string' && r.json.token) { adopt(r.json, state ? state.savedAt : undefined); return { ok: true, status: r.status }; }
      if (r.status === 401 || r.status === 403 || r.status === 404) return { ok: false, status: r.status, invalid: true };
      return { ok: false, status: r.status, network: true };
    });
  };

  /** 開いた時(約束 §2.1 / §2.4)。status: 'ok' | 'offline'(覚えた札で開く) | 'login'(ログインの画面へ) */
  const start = () => {
    if (state) {
      return refresh().then((r) => {
        if (r.ok) return { status: 'ok' };
        if (r.invalid) {
          logout('expired');
          return { status: 'login', message: 'この端末のログインが切れました(止められたか、期限が切れました)。もう一度つないでください' };
        }
        return { status: 'offline', message: `社内サーバーにつながりません(${r.status || '通信できません'})。覚えたログインのまま開きます` };
      });
    }
    const legacy = readLegacyDevice(storage);
    if (legacy) {
      clearLegacyDevice(storage);   // ⚠成否に関わらず消す(合言葉を端末に残さない)
      return login(legacy.email, legacy.password).then((r) => (r.ok ? { status: 'ok', migrated: 'legacy' } : { status: 'login', message: r.message }));
    }
    const cc = configCreds && typeof configCreds === 'object' ? configCreds : null;
    const ccEmail = cc ? str(cc.email) : '';
    if (cc && ccEmail && typeof cc.password === 'string' && cc.password && sGet(storage, CONFIG_CREDS_USED_KEY) !== ccEmail) {
      sSet(storage, CONFIG_CREDS_USED_KEY, ccEmail);   // 1回だけ(次からは無視する)
      return login(ccEmail, cc.password).then((r) => (r.ok ? { status: 'ok', migrated: 'config' } : { status: 'login', message: r.message }));
    }
    return Promise.resolve({ status: 'login' });
  };

  /** 前の auth-refresh から 6 時間以上なら延ばす(約束 §2.3)。使えない札ならログアウト。 */
  const maybeRefresh = () => {
    if (!state) return Promise.resolve({ ok: false, skipped: true });
    const last = Date.parse(state.refreshedAt) || 0;
    if (now() - last < REFRESH_INTERVAL_MS) return Promise.resolve({ ok: true, skipped: true });
    return refresh().then((r) => { if (!r.ok && r.invalid) logout('expired'); return r; });
  };

  /** どこかの呼び出しが 401 だった時: 1回だけ延ばしてみる。だめならログアウト(書きかけは保存待ちの箱に残る)。
   *  @returns 新しい札(使えなければ null) */
  const handleUnauthorized = () => {
    if (unauthPending) return unauthPending;
    const clear = (v) => { unauthPending = null; return v; };
    unauthPending = refresh().then((r) => {
      if (r.ok) return state.token;
      if (r.invalid) logout('unauthorized');
      return null;
    }).then(clear, (e) => { clear(); throw e; });
    return unauthPending;
  };

  /** 写真の札(約束 §3)。メモリにだけ置く。30 分より古ければ取り直す。取れなければ前の札(無ければ null)。 */
  const getFileToken = ({ force = false } = {}) => {
    if (!state) return Promise.resolve(null);
    if (!force && fileTok && now() - fileTokAt < FILE_TOKEN_INTERVAL_MS) return Promise.resolve(fileTok);
    if (fileTokPending) return fileTokPending;
    const clear = (v) => { fileTokPending = null; return v; };
    fileTokPending = post('/api/files/token', { token: state.token })
      .then((r) => ((r.status === 401 && state)
        ? handleUnauthorized().then((t) => (t ? post('/api/files/token', { token: t }) : r))
        : r))
      .then((r) => {
        if (r.ok && r.json && typeof r.json.token === 'string' && r.json.token) {
          fileTok = r.json.token; fileTokAt = now();
          emit('fileToken', fileTok);
        }
        return fileTok;
      })
      .then(clear, (e) => { clear(); throw e; });
    return fileTokPending;
  };

  return {
    get token() { return state ? state.token : null; },
    get info() { return state ? { email: state.email, label: state.label, recordId: state.recordId, refreshedAt: state.refreshedAt } : null; },
    get baseUrl() { return base; },
    isLoggedIn: () => !!state,
    currentFileToken: () => fileTok,
    fileTokenAgeMs: () => (fileTok ? now() - fileTokAt : Infinity),
    start, login, refresh, maybeRefresh, handleUnauthorized, getFileToken, logout,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
};

/** 6 時間ごとの延長と 30 分ごとの写真の札(約束 §2.3 / §3)。画面が前に出た時も確かめる。@returns 止める関数 */
export const startDeviceSessionTimers = (session, { setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, doc = (typeof document !== 'undefined' ? document : null), tickMs = 5 * 60 * 1000 } = {}) => {
  const tick = () => {
    if (!session.isLoggedIn()) return;
    session.maybeRefresh().catch(() => { /* 次の回 */ });
    if (session.fileTokenAgeMs() >= FILE_TOKEN_INTERVAL_MS) session.getFileToken({ force: true }).catch(() => { /* 次の回 */ });
  };
  const id = setIntervalImpl(tick, tickMs);
  const onVis = () => { if (!doc || doc.visibilityState === 'visible') tick(); };
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis);
  return () => { clearIntervalImpl(id); if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis); };
};

// ---- PocketBase への呼び出しに今の札を付ける(画面の fetch の入口で使う・src/onpremFiles.js) ----
const AUTH_PATH = /\/api\/collections\/[^/]+\/auth-/;
const FILE_TOKEN_PATH = /\/api\/files\/token(?:[?#]|$)/;

/** PocketBase の /api/ への呼び出しか(apiBase の下・または住所なしの /api/)。 */
export const isPbApiUrl = (url, apiBase = '') => {
  const s = String(url || '');
  const b = String(apiBase || '').replace(/\/+$/, '');
  return /^\/api\//.test(s) || (!!b && s.startsWith(`${b}/api/`));
};

const withAuthHeader = (init, token) => {
  const H = typeof Headers === 'function' ? Headers : null;
  // ⚠ 物の展開({ ...x })を書かない(古い Safari 向けの変換で助けの部品を読む呼び出しになり、いつものビルドの出力に残る)。Object.assign で書く。
  if (H) { const h = new H((init && init.headers) || {}); h.set('Authorization', token); return Object.assign({}, init || {}, { headers: h }); }
  return Object.assign({}, init || {}, { headers: Object.assign({}, (init && init.headers) || {}, { Authorization: token }) });
};

/**
 * 画面の fetch を包む(約束 §2.3・§3):
 *   ・PocketBase の /api/…(ログインの道と写真の札の道を除く)には **今の札** を Authorization に入れる
 *     (窓口 pbClient は合言葉でログインしない。札は延ばすたびに替わるので、送る瞬間の札を使う)
 *   ・401 → 札を1回延ばしてやり直す。だめなら持ち手がログアウトする(画面の入口がログインの画面を重ねる)
 *   ・/api/files/… には写真の札を ?token= で付ける(Authorization だけでは守った写真は返らない)
 * ⚠ Request の物で来た呼び出しは写真の札だけ(中身を作り直さない)。
 */
export const makeSessionFetch = (session, { fetchImpl, apiBase = '', allowedOrigins = null } = {}) => {
  const f = fetchImpl || ((...a) => fetch(...a));
  return (input, init) => {
    let url = null;
    if (typeof input === 'string') url = input;
    else if (input && typeof input === 'object' && typeof input.href === 'string' && typeof input.method !== 'string') url = input.href;
    if (url === null) return f(input, init);
    if (isPbFileUrl(url, allowedOrigins) && session.currentFileToken()) url = withFileToken(url, session.currentFileToken(), allowedOrigins);
    const api = isPbApiUrl(url, apiBase) && !AUTH_PATH.test(url) && !FILE_TOKEN_PATH.test(url);
    const first = (api && session.token) ? withAuthHeader(init, session.token) : init;
    return Promise.resolve(f(url, first)).then((res) => {
      if (!api || !res || res.status !== 401) return res;
      return session.handleUnauthorized().then((t) => (t ? f(url, withAuthHeader(init, t)) : res));
    });
  };
};

// ============================================================================
// (2) 社内サーバ版(オンプレ)だけ: 守った写真(blobs.file = protected)を画面に出す為に、表示の時だけ ?token= を付ける — 2026-10-30
// ----------------------------------------------------------------------------
// 約束: C:\Users\anrw3\tmp-onprem-e2e\CONTRACT_device_login.md §3
// 部品の画面には写真の URL を出す所が 100 か所近くある(<img src>・<video src>・背景の url(...)・印刷の窓へ document.write・
// 動画の書き出しの fetch など)。1つずつ直すと必ず漏れるので、**ブラウザの入口で** 付ける:
//   ・属性 src / href / poster(setAttribute と要素の src 等の書き込み)
//   ・style の background / background-image(React は style[名前] = 値 で書く)
//   ・window.fetch(印刷・PDF・動画の書き出しが写真を取る所)。PocketBase の /api/ には今の端末の札も入れる(401 は1回延ばす)
//   ・window.open で開いた窓(印刷の窓)の document.write の HTML
//   ・上で拾えない入り方(innerHTML 等)は MutationObserver で後から付ける
//   ・写真が 404 → 札を1回取り直してもう一度(札が切れた時)
// ⚠ 札は表示の時だけ付ける。書類に保存する URL(storedFileUrl)は今まで通り札なし。
// ⚠ 付けるのは「住所なしの /api/files/…」と「PocketBase の口・画面の口の /api/files/…」だけ。よその口へ札を渡さない。
// ⚠ 社内版のビルドの時だけ呼ばれる(src/onpremGate.js)。いつものビルドの出力には入らない。
// ============================================================================

const URL_ATTRS = ['src', 'href', 'poster'];
const SELECTOR = '[src*="/api/files/"],[href*="/api/files/"],[poster*="/api/files/"],[style*="/api/files/"]';

/** 書き込みの所を包む(元の物を呼ぶ)。見つからなければ何もしない。 */
const wrapSetter = (proto, prop, fix) => {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, prop);
    if (!d) continue;
    if (!d.set || !d.configurable) return false;
    Object.defineProperty(p, prop, Object.assign({}, d, { set(v) { return d.set.call(this, fix(v)); } }));
    return true;
  }
  return false;
};

/**
 * @param session   createDeviceSession の持ち手(currentFileToken / getFileToken)
 * @param win       window(試験で差し替える)
 * @param origins   札を付けてよい口(PocketBase の口・画面の口)
 * @param apiBase   PocketBase の住所(この下の /api/ に今の札を入れる)
 * @returns 入れた所の一覧(確かめ用)
 */
export const installFileTokenLayer = ({ session, win = window, origins = [], apiBase = '' } = {}) => {
  if (!win || win.__onpremFileLayer) return (win && win.__onpremFileLayer) || null;
  const allowed = Array.from(new Set(origins.filter(Boolean).map((o) => String(o).replace(/\/+$/, ''))));
  const tok = () => session.currentFileToken();
  const fix = (v) => (typeof v === 'string' && tok() ? withFileToken(v, tok(), allowed) : v);
  const fixCss = (v) => (typeof v === 'string' && tok() ? rewriteCssUrls(v, tok(), allowed) : v);
  const fixHtml = (v) => (typeof v === 'string' && tok() ? rewriteHtmlFileUrls(v, tok(), allowed) : v);
  const done = [];

  const patchRealm = (w) => {
    if (!w || w.__onpremFilePatched) return;
    w.__onpremFilePatched = true;
    const EP = w.Element && w.Element.prototype;
    if (EP && EP.setAttribute) {
      const orig = EP.setAttribute;
      EP.setAttribute = function setAttribute(name, value) {
        const n = String(name).toLowerCase();
        if (typeof value === 'string') {
          if (n === 'src' || n === 'href' || n === 'poster') value = fix(value);
          else if (n === 'style') value = fixCss(value);
        }
        return orig.call(this, name, value);
      };
      done.push('setAttribute');
    }
    for (const [C, prop] of [['HTMLImageElement', 'src'], ['HTMLMediaElement', 'src'], ['HTMLSourceElement', 'src'],
      ['HTMLVideoElement', 'poster'], ['HTMLAnchorElement', 'href'], ['HTMLIFrameElement', 'src']]) {
      if (w[C] && wrapSetter(w[C].prototype, prop, fix)) done.push(`${C}.${prop}`);
    }
    const styleProto = w.CSSStyleDeclaration && w.CSSStyleDeclaration.prototype;
    if (styleProto) {
      // 写真が入るのは背景だけ(背景の地図・図)。名前の付いた書き込みは style の物の作り(親の型)まで探す。
      const sample = w.document && w.document.documentElement && w.document.documentElement.style;
      const protoOfSample = sample ? Object.getPrototypeOf(sample) : styleProto;
      for (const prop of ['backgroundImage', 'background']) { if (wrapSetter(protoOfSample, prop, fixCss)) done.push(`style.${prop}`); }
      const origSP = styleProto.setProperty;
      if (origSP) {
        styleProto.setProperty = function setProperty(n, v, pr) { return origSP.call(this, n, fixCss(v), pr); };
        done.push('style.setProperty');
      }
    }
    const DP = w.Document && w.Document.prototype;
    if (DP) {
      for (const m of ['write', 'writeln']) {
        const o = DP[m];
        if (typeof o === 'function') { DP[m] = function writeWithFileToken(...parts) { return o.apply(this, parts.map(fixHtml)); }; done.push(`document.${m}`); }
      }
    }
  };
  patchRealm(win);

  if (typeof win.fetch === 'function') {
    // 写真の札・PocketBase の札(今の札を送る・401 は1回延ばしてやり直す)を同じ入口で(src/onpremDevice.js の makeSessionFetch)。
    const origFetch = win.fetch.bind(win);
    const sessionFetch = makeSessionFetch(session, { fetchImpl: origFetch, apiBase, allowedOrigins: allowed });
    win.fetch = function fetchWithDeviceSession(input, init) {
      if (win.Request && input instanceof win.Request) {
        try { if (isPbFileUrl(input.url, allowed) && tok()) input = new win.Request(fix(input.url), input); } catch { /* そのまま */ }
        return origFetch(input, init);
      }
      return sessionFetch(input, init);
    };
    done.push('fetch');
  }

  if (typeof win.open === 'function') {
    const origOpen = win.open;
    win.open = function openWithFileToken(url, ...rest) {
      const w = origOpen.call(this, typeof url === 'string' ? fix(url) : url, ...rest);
      try { patchRealm(w); } catch { /* よその口の窓は触れない */ }
      return w;
    };
    done.push('open');
  }

  const doc = win.document;
  // 札が切れた写真: 1回だけ札を取り直してもう一度(約束 §3 の 6)。
  const onError = (ev) => {
    const el = ev && ev.target;
    if (!el || !el.tagName || (el.tagName !== 'IMG' && el.tagName !== 'VIDEO')) return;
    const src = el.getAttribute('src') || '';
    if (!isPbFileUrl(src, allowed) || el.__onpremRetried) return;
    el.__onpremRetried = true;
    session.getFileToken({ force: session.fileTokenAgeMs() > 60 * 1000 }).then((t) => {
      if (t) el.setAttribute('src', withFileToken(src, t, allowed));
    }).catch(() => { /* 写真がありません のまま */ });
  };
  if (doc && doc.addEventListener) { doc.addEventListener('error', onError, true); done.push('error-retry'); }

  // innerHTML 等で入った物・背景の絵(style.backgroundImage = …)は後から付ける。
  //   ⚠ Chrome では style の backgroundImage は1つずつの style の物に付いた書き込みで、型(prototype)の所では包めない(実測 2026-10-30)。
  //     React は style[名前] = 値 で書くので、style の属性が変わった所を見て札を付け直す(1回目の読みは 404 になり、付け直した URL で読み直す)。
  let mo = null;
  if (doc && typeof win.MutationObserver === 'function') {
    const fixEl = (el) => {
      for (const a of URL_ATTRS) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && isPbFileUrl(v, allowed) && !/[?&]token=/.test(v) && tok()) el.setAttribute(a, v);
      }
      const st = el.getAttribute && el.getAttribute('style');
      if (st && st.indexOf('/api/files/') >= 0 && el.style) {
        for (const prop of ['backgroundImage', 'background']) {
          const cur = el.style[prop];
          if (cur && cur.indexOf('/api/files/') >= 0) { const nv = fixCss(cur); if (nv !== cur) el.style[prop] = nv; }
        }
      }
    };
    mo = new win.MutationObserver((records) => {
      if (!tok()) return;
      for (const r of records) {
        if (r.type === 'attributes') { fixEl(r.target); continue; }
        for (const n of r.addedNodes || []) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(SELECTOR)) fixEl(n);
          if (n.querySelectorAll) n.querySelectorAll(SELECTOR).forEach(fixEl);
        }
      }
    });
    mo.observe(doc.documentElement || doc, { subtree: true, childList: true, attributes: true, attributeFilter: URL_ATTRS.concat(['style']) });
    done.push('mutation-observer');
  }

  const layer = { done, allowed, stop: () => { if (mo) mo.disconnect(); } };
  win.__onpremFileLayer = layer;
  return layer;
};

// ---- 今の持ち手(画面の入口が1つ作り、App の起動の所が使う) ----
let _current = null;
export const setDeviceSession = (s) => { _current = s; };
export const getDeviceSession = () => _current;

/** 保管庫の窓口(pbClient)に今の札を入れ、延ばしたら入れ直す。
 *  ⚠窓口は「札が入っているか(isAuthed)」を見てから読む(入っていないと「まだログインできていません」で止める)。
 *  送る時の Authorization は fetch の入口(makeSessionFetch)が毎回今の札に替えるが、この印の為に窓口にも入れる。 */
export const attachSessionToPbClient = (session, client) => {
  if (!session || !client || typeof client.setToken !== 'function') return false;
  if (session.token) client.setToken(session.token);
  session.onChange((ev, v) => { if (ev === 'token' && v) client.setToken(v); });
  return true;
};

// ---- (3) ログインの画面(最初の1回・札が使えなくなった時)と起動 -----------------------------
// ⚠ React を使わず DOM で作る(このファイルは何も import しない決まり・上の注意)。画面(App)の上に重ねるだけで、App は閉じない
//   (札が使えなくなっても書きかけは保存待ちの箱に残る)。見た目は el.style(CSSOM)で入れるので CSP の style にも頼らない。
const EXPIRED_NOTICE = 'この端末のログインが切れました(止められたか、期限が切れました)。もう一度つないでください';
const css = (el, o) => { for (const k of Object.keys(o)) el.style[k] = o[k]; return el; };

/**
 * ログインの画面(約束 §2.2)。open(notice) はログインできた時に終わる Promise を返す。
 * @param appName     説明に出すアプリの名前
 * @param configFile  「ファイルから読む」の説明に出す設定ファイルの名前
 */
export const makeLoginOverlay = ({ session, win = window, appName = '', configFile = 'onprem-config.json' } = {}) => {
  const doc = win.document;
  let root = null;
  let waiters = [];
  const el = (tag, style, text) => { const e = doc.createElement(tag); if (style) css(e, style); if (text) e.textContent = text; return e; };
  const close = () => { if (root && root.parentNode) root.parentNode.removeChild(root); root = null; };
  const build = (notice) => {
    root = el('div', { position: 'fixed', inset: '0', zIndex: '2147483000', background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflow: 'auto', padding: '16px', boxSizing: 'border-box', fontFamily: 'sans-serif' });
    root.setAttribute('data-onprem-login', '1');
    const form = el('form', { width: '100%', maxWidth: '520px', marginTop: '40px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.15)', boxSizing: 'border-box' });
    form.appendChild(el('h2', { fontSize: '18px', fontWeight: '700', color: '#0f172a', margin: '0 0 8px' }, 'この端末を社内サーバーにつなぐ(最初の1回だけ)'));
    form.appendChild(el('p', { fontSize: '14px', color: '#475569', margin: '0 0 12px' },
      `${appName ? `${appName}。` : ''}管理者から渡された この PC 用 の端末アカウントを入れてください(管理者のアカウントは入れないでください)。`));
    if (notice) {
      const noticeBox = el('div', { fontSize: '14px', color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '8px', padding: '8px', marginBottom: '12px' }, notice);
      noticeBox.setAttribute('role', 'status');
      form.appendChild(noticeBox);
    }
    const field = (label, type, ac) => {
      const l = el('label', { display: 'block', fontSize: '14px', color: '#334155', marginTop: '12px' }, label);
      const i = el('input', { display: 'block', width: '100%', marginTop: '4px', padding: '10px', fontSize: '16px', minHeight: '44px', border: '1px solid #94a3b8', borderRadius: '8px', boxSizing: 'border-box' });
      i.type = type; i.autocomplete = ac; i.name = ac === 'username' ? 'username' : 'password';
      l.appendChild(i); form.appendChild(l);
      return i;
    };
    const email = field('メールアドレス', 'text', 'username');
    const pass = field('合言葉', 'password', 'current-password');
    const err = el('div', { color: '#b91c1c', marginTop: '12px', fontSize: '14px', minHeight: '1em' });
    err.setAttribute('role', 'alert');
    form.appendChild(err);
    const row = el('div', { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '16px' });
    const btn = el('button', { padding: '10px 18px', minHeight: '44px', fontSize: '16px', borderRadius: '8px', background: '#2563eb', color: '#fff', border: '0', fontWeight: '700' }, 'つなぐ');
    btn.type = 'submit';
    const fileBtn = el('button', { padding: '10px 18px', minHeight: '44px', fontSize: '16px', borderRadius: '8px', background: '#fff', color: '#1e293b', border: '1px solid #94a3b8' }, 'ファイルから読む');
    fileBtn.type = 'button';
    const file = el('input', { display: 'none' });
    file.type = 'file'; file.accept = '.json,application/json';
    row.appendChild(btn); row.appendChild(fileBtn); row.appendChild(file); form.appendChild(row);
    form.appendChild(el('p', { fontSize: '12px', color: '#64748b', margin: '12px 0 0' },
      `「ファイルから読む」: 管理者が配った device-login.json(またはこの PC 用の ${configFile})を選びます。読んだ後のファイルは消してください。`));
    const busy = (on) => { btn.disabled = on; fileBtn.disabled = on; btn.textContent = on ? '確かめています…' : 'つなぐ'; };
    const tryLogin = (em, pw) => {
      busy(true); err.textContent = '';
      return session.login(em, pw).then((r) => {
        if (!r.ok) { err.textContent = r.message; return null; }
        return session.getFileToken({ force: true }).catch(() => null).then(() => {
          close();
          const w = waiters; waiters = [];
          for (const fn of w) fn(true);
        });
      }).then(() => busy(false), (e) => { busy(false); err.textContent = String((e && e.message) || e); });
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const pw = pass.value;
      pass.value = '';   // ⚠合言葉は画面に残さない(約束 §2.2)
      tryLogin(email.value, pw);
    });
    fileBtn.addEventListener('click', () => file.click());
    file.addEventListener('change', () => {
      const f = file.files && file.files[0];
      file.value = '';
      if (!f) return;
      f.text().then((text) => {
        let json = null;
        try { json = JSON.parse(text); } catch { err.textContent = 'JSON として読めません'; return; }
        const c = credentialsFromLoginFile(json);
        json = null;
        if (!c.ok) { err.textContent = c.message; return; }
        email.value = c.email;
        tryLogin(c.email, c.password);   // 読んだ中身は覚えない
      }, () => { err.textContent = 'ファイルを読めません'; });
    });
    root.appendChild(form);
    (doc.body || doc.documentElement).appendChild(root);
    try { email.focus(); } catch { /* 無くてよい */ }
  };
  return {
    isOpen: () => !!root,
    open: (notice = '') => {
      if (!root) build(notice);
      return new Promise((resolve) => { waiters.push(resolve); });
    },
    close,
  };
};

/** 社内サーバーにつながらない時の帯(閉じられる)。 */
export const showOfflineBanner = (message, win = window) => {
  const doc = win.document;
  const bar = css(doc.createElement('div'), { position: 'fixed', top: '0', left: '0', right: '0', zIndex: '2147482000', background: '#fef3c7', borderBottom: '1px solid #fcd34d', color: '#78350f', fontSize: '14px', padding: '4px 12px', display: 'flex', gap: '8px', alignItems: 'center', fontFamily: 'sans-serif' });
  bar.setAttribute('role', 'status');
  bar.setAttribute('data-onprem-offline', '1');
  const t = doc.createElement('span'); t.textContent = message; t.style.flex = '1';
  const b = css(doc.createElement('button'), { padding: '2px 8px', minHeight: '32px', borderRadius: '4px', border: '1px solid #fbbf24', background: '#fff' });
  b.type = 'button'; b.textContent = '閉じる';
  b.addEventListener('click', () => { if (bar.parentNode) bar.parentNode.removeChild(bar); });
  bar.appendChild(t); bar.appendChild(b);
  (doc.body || doc.documentElement).appendChild(bar);
  return bar;
};

/**
 * 起動(約束 §2.1〜§2.4・§3)。App の社内版の起動の所が、保管庫を開く前に1回呼ぶ。
 *   ①札の持ち手を作る ②写真の札・PocketBase の札を fetch などの入口で付ける ③覚えた札を延ばす/移し替え/ログインの画面
 *   ④写真の札を取る ⑤6時間ごとの延長と30分ごとの写真の札 ⑥使っている間に札が使えなくなったらログインの画面を重ねる
 * @param cfg  loadOnpremConfig の結果({ url, authCollection, email?, password? })
 * @returns { session, status }  status: 'ok' | 'offline' | 'login'(ログインの画面で入った)
 */
// ⚠ async を書かない(このファイルの決まり・上の post の注意)。
export const bootDeviceSession = ({ cfg, win = window, appName = '', configFile = 'onprem-config.json' } = {}) => {
  let storage = null;
  try { storage = win.localStorage; } catch { /* 覚えられない端末: 毎回ログイン */ }
  const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const session = createDeviceSession({
    baseUrl: cfg.url, collection: cfg.authCollection, storage,
    configCreds: (cfg.email && cfg.password) ? { email: cfg.email, password: cfg.password } : null,
  });
  setDeviceSession(session);
  installFileTokenLayer({ session, win, origins: [(win.location && win.location.origin) || '', originOf(cfg.url)], apiBase: cfg.url });
  const ui = makeLoginOverlay({ session, win, appName, configFile });
  session.onChange((ev) => { if (ev === 'loggedOut' && !ui.isOpen()) ui.open(EXPIRED_NOTICE); });
  return session.start().then((r) => {
    let waitLogin = null;
    if (r.status === 'login') {
      if (ui.isOpen()) ui.close();
      waitLogin = ui.open(r.message || '');
    } else if (r.status === 'offline') {
      showOfflineBanner(r.message || '社内サーバーにつながりません', win);
    }
    return Promise.resolve(waitLogin)
      .then(() => session.getFileToken().catch(() => null))
      .then(() => {
        startDeviceSessionTimers(session, { doc: win.document });
        return { session, status: r.status };
      });
  });
};
