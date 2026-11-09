// ============================================================================
// 社内版の通知の切替(2026-10-31)— relay(今の中継・既定) / signal(社内の Web Push・本文なし)
// ----------------------------------------------------------------------------
// ⚠このファイルは 製品・最終・部品・③ で1バイトも違わない(src/data/webPushClient.js・試験が md5 を見張る)。
//   ③ は持つだけ(送る所が無い)。
// ⚠いつものビルド(Firebase 版)では使わない。社内版の呼ぶ所が `社内版 ? … : …` で畳まれ、このファイルはビルドに入らない。
//   なので: import しない・一番上で何も動かさない(関数と文字の定数だけ)・async を書かない(Promise の鎖で書く)。
//
// 切替は onprem-config.json の "pushMode": "relay"(書かない時もこれ) | "signal"。作り直し不要。
//   relay  … 今と同じ。送る = 中継(Worker /fcm/send)。受ける = Firebase の 'onprem-push' の getAuth。
//            それに加えて notify_queue へ「種類(category)とアプリ(ns)だけ」の行を1件(mode "relay")入れる
//            (サーバーの送信係が緊急の種類だけ Teams へ決まった文を出す)。入れられなくても業務は止めない。
//   signal … Firebase も Cloudflare も呼ばない。GET /__push/v1/config の VAPID 公開鍵で pushManager.subscribe、
//            push_subs に宛先を作り、端末の宛先は push_tokens の token "wp:"+sid。
//            送る = notify_queue に行(mode "signal"・宛先 sids・文面)を入れるだけ。送信係が本文 0B の push を出し、
//            SW(onprem-sw.js)が /__push/v1/inbox から自分の分を取って出す。
//   秘密(secret)は端末の IndexedDB(鍵 = registration.scope)にだけ置く。push_subs には sha256 の16進(secretHash)だけ。
//   lan    … 2026-11-09 案A(社内版の一式の既定)。会社の外へは何も出さない。各 PC の「受け取り係」(notify-receiver.ps1)が
//            社内サーバーに繋ぎっぱなしで待ち、Windows の通知を出す。端末の宛先は push_tokens の token "lan:"+rid(受け取り係の id)。
//            rid は受け取り係を入れた時に開く画面の #lanrid=<rid> から覚える(localStorage onpremLanRid・# は住所から消す)。
//            送る = notify_queue に行(mode "lan"・宛先 rids・文面)を入れるだけ。🔔 の登録の画面(side・group・role・admin)は今のまま。
// ============================================================================

export const PUSH_MODE_RELAY = 'relay';
export const PUSH_MODE_SIGNAL = 'signal';
export const PUSH_MODE_LAN = 'lan';
/** 設定の pushMode をそろえる。"signal" / "lan" と書いた時だけその方式。それ以外(無い・空・違う字)は relay。 */
export const pushModeOf = (v) => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === PUSH_MODE_SIGNAL ? PUSH_MODE_SIGNAL : (s === PUSH_MODE_LAN ? PUSH_MODE_LAN : PUSH_MODE_RELAY);
};

/** push_tokens の token の頭。signal で作った宛先はこれ + push_subs の id。 */
export const WP_TOKEN_PREFIX = 'wp:';
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isWpToken = (t) => typeof t === 'string' && t.indexOf(WP_TOKEN_PREFIX) === 0 && SID_RE.test(t.slice(WP_TOKEN_PREFIX.length));
export const sidOfToken = (t) => (isWpToken(t) ? t.slice(WP_TOKEN_PREFIX.length) : '');
/** push_tokens の token の頭。社内の受け取り係(PC の notify-receiver)の宛先はこれ + notify_receivers の id(rid)。 */
export const LAN_TOKEN_PREFIX = 'lan:';
/** rid の形(PocketBase の自動の id = 小文字と数字の15字)。サーバーの送信係・フックと同じ。 */
const RID_RE = /^[a-z0-9]{15}$/;
export const isLanToken = (t) => typeof t === 'string' && t.indexOf(LAN_TOKEN_PREFIX) === 0 && RID_RE.test(t.slice(LAN_TOKEN_PREFIX.length));
export const ridOfToken = (t) => (isLanToken(t) ? t.slice(LAN_TOKEN_PREFIX.length) : '');
/**
 * 中継(relay)へ渡してよい token の形 = ブラウザの FCM の登録 token("<端末の番号>:APA91…")だけ。
 * 2026-11-09 案A: 前は「wp: 以外は全部 FCM」としていたので、知らない形(lan: など)の宛先まで中継(社外)へ渡っていた。
 */
const FCM_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}:APA91[A-Za-z0-9_-]{20,4000}$/;
export const isFcmToken = (t) => typeof t === 'string' && FCM_TOKEN_RE.test(t);
/**
 * 宛先の token を分ける。fcm = 中継(relay)へ渡す物 / sids = signal の宛先 / rids = 受け取り係(lan)の宛先。
 * ⚠"wp:"・"lan:" で始まる物は形が正しくても違っても中継へ渡さない。
 * ⚠FCM の形でない物(知らない頭・ただの字)はどこへも渡さない(捨てる)。重なりは1つに。
 */
export const splitPushTokens = (tokens) => {
  const fcm = []; const sids = []; const rids = []; const seenF = {}; const seenS = {}; const seenR = {};
  const list = Array.isArray(tokens) ? tokens : [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (typeof t !== 'string' || !t) continue;
    if (t.indexOf(WP_TOKEN_PREFIX) === 0) {
      const sid = sidOfToken(t);
      if (sid && !seenS[sid]) { seenS[sid] = 1; sids.push(sid); }
    } else if (t.indexOf(LAN_TOKEN_PREFIX) === 0) {
      const rid = ridOfToken(t);
      if (rid && !seenR[rid]) { seenR[rid] = 1; rids.push(rid); }
    } else if (isFcmToken(t) && !seenF[t]) { seenF[t] = 1; fcm.push(t); }
  }
  return { fcm: fcm, sids: sids, rids: rids };
};

/**
 * 通知の種類(サーバーの Teams の表と同じ名前)。tag と title から決める。
 *  -cc で終わる(管理者への写し)= cc … ⚠先に見る(元の連絡と二重に Teams へ出さない)
 *  req- + 修正依頼 = repair / req- + 呼出 = call / int- = internal / reply- + 行けない = cantgo
 *  esc- = escalate / rem- = remind / push-test- = test / ほか = info
 */
export const noticeCategoryOf = (args) => {
  const tag = String((args && args.tag) || '');
  const title = String((args && args.title) || '');
  if (/-cc$/.test(tag)) return 'cc';
  if (tag.indexOf('push-test-') === 0) return 'test';
  if (tag.indexOf('req-') === 0) {
    if (title.indexOf('修正依頼') >= 0) return 'repair';
    if (title.indexOf('呼出') >= 0) return 'call';
    return 'info';
  }
  if (tag.indexOf('int-') === 0) return 'internal';
  if (tag.indexOf('reply-') === 0) return title.indexOf('行けない') >= 0 ? 'cantgo' : 'info';
  if (tag.indexOf('esc-') === 0) return 'escalate';
  if (tag.indexOf('rem-') === 0) return 'remind';
  return 'info';
};

// --- 形の確かめ ---------------------------------------------------------------
/** VAPID の公開鍵(P-256 の非圧縮点 65 バイトの base64url = "B" で始まる約 87 字)。 */
export const isVapidPublicKey = (k) => typeof k === 'string' && /^B[A-Za-z0-9_-]{85,90}$/.test(k.trim());
/** ブラウザの会社の push の口(サーバーの送信係と同じ3つ)。 */
export const PUSH_ENDPOINT_HOSTS = ['fcm.googleapis.com', '*.notify.windows.com', 'web.push.apple.com'];
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** 購読の endpoint が許した口か(https・443・user:pass なし・IP なし・名前がぴったり / *. の後ろ)。 */
export const isAllowedPushEndpoint = (raw) => {
  const s = String(raw || '');
  if (!s || s.length > 2048 || !/^https:\/\/[^/@]+\//i.test(s) || /[\s\\]/.test(s)) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase();
  if (!host || /^[0-9.]+$/.test(host) || host.charAt(0) === '[' || host.charAt(host.length - 1) === '.') return false;
  if (!host.split('.').every((l) => LABEL_RE.test(l) && l.indexOf('xn--') !== 0)) return false;
  for (let i = 0; i < PUSH_ENDPOINT_HOSTS.length; i++) {
    const p = PUSH_ENDPOINT_HOSTS[i];
    if (p.indexOf('*.') === 0) {
      const suf = p.slice(1);
      if (host.length > suf.length && host.slice(-suf.length) === suf) return true;
    } else if (host === p) return true;
  }
  return false;
};
/** origin の形(http(s)://名前[:口])だけ通す。 */
const originOf = (o) => { try { const u = new URL(String(o || '')); return /^https?:$/.test(u.protocol) ? u.origin : ''; } catch { return ''; } };
/** 同じ口(origin)の URL か。 */
export const isSameOriginUrl = (url, origin) => {
  const o = originOf(origin);
  if (!o) return false;
  try { return new URL(String(url), o + '/').origin === o; } catch { return false; }
};
/** 通知のリンク: 同じ口の「パス + ? + #」だけ。違う口・形がおかしい物は fallback(SW の scope)。 */
export const safeNoticeLink = (link, origin, fallback) => {
  const o = originOf(origin);
  const fb = (fallback === undefined || fallback === null) ? '' : String(fallback);
  if (!o || !link) return fb;
  const s = String(link);
  if (/^\s*(javascript|data|blob|file|vbscript):/i.test(s) || /^\s*\/\//.test(s) || /\\/.test(s)) return fb;
  try {
    const u = new URL(s, o + '/');
    if (u.origin !== o) return fb;
    return u.pathname + u.search + u.hash;
  } catch { return fb; }
};
/** /__push/v1/ の口(config | inbox | renew だけ)。画面と同じ口の一番上。 */
export const PUSH_API_NAMES = ['config', 'inbox', 'renew'];
export const pushApiUrl = (origin, name) => {
  const o = originOf(origin);
  if (!o || PUSH_API_NAMES.indexOf(name) < 0) throw new Error('通知の口の名前か住所がおかしいです');
  return o + '/__push/v1/' + name;
};

// --- 小さな部品 ---------------------------------------------------------------
export const b64uToBytes = (s) => {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4 ? '===='.slice(t.length % 4) : '';
  const bin = atob(t + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
export const bytesToB64u = (bytes) => {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const cryptoOf = (c) => c || (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
/** 32 バイトの乱数(base64url)。⚠crypto.getRandomValues だけを使う(Math.random は使わない)。 */
export const randomSecret = (cryptoImpl) => {
  const c = cryptoOf(cryptoImpl);
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('この端末は安全な乱数を作れません');
  return bytesToB64u(c.getRandomValues(new Uint8Array(32)));
};
/** sha256 の16進(push_subs に置くのはこれだけ)。 */
export const sha256Hex = (text, cryptoImpl) => {
  const c = cryptoOf(cryptoImpl);
  if (!c || !c.subtle) return Promise.reject(new Error('この端末は sha256 を計算できません(https で開いてください)'));
  return c.subtle.digest('SHA-256', new TextEncoder().encode(String(text))).then((buf) => {
    const b = new Uint8Array(buf); let h = '';
    for (let i = 0; i < b.length; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return h;
  });
};
const sameBytes = (a, b) => {
  if (!a || !b) return false;
  const x = new Uint8Array(a); const y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
};

// --- IndexedDB(鍵 = registration.scope)。SW(onprem-sw.js)も同じ名前で読む -----
export const PUSH_IDB_NAME = 'onprem-push';
export const PUSH_IDB_STORE = 'subs';
const idbOf = (f) => f || (typeof indexedDB !== 'undefined' ? indexedDB : null);
const idbOpen = (factory) => new Promise((resolve, reject) => {
  const f = idbOf(factory);
  if (!f) { reject(new Error('この端末は IndexedDB を使えません')); return; }
  const req = f.open(PUSH_IDB_NAME, 1);
  req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(PUSH_IDB_STORE)) db.createObjectStore(PUSH_IDB_STORE); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('IndexedDB を開けません'));
});
const idbRun = (factory, mode, fn) => idbOpen(factory).then((db) => new Promise((resolve, reject) => {
  const tx = db.transaction(PUSH_IDB_STORE, mode);
  const req = fn(tx.objectStore(PUSH_IDB_STORE));
  let val;
  req.onsuccess = () => { val = req.result; };
  tx.oncomplete = () => { try { db.close(); } catch { /* noop */ } resolve(val); };
  tx.onerror = () => reject(tx.error || req.error || new Error('IndexedDB に書けません'));
  tx.onabort = tx.onerror;
}));
export const idbGetSub = (scope, factory) => idbRun(factory, 'readonly', (s) => s.get(String(scope))).then((v) => (v && typeof v === 'object' ? v : null));
export const idbPutSub = (scope, value, factory) => idbRun(factory, 'readwrite', (s) => s.put(value, String(scope)));
export const idbDeleteSub = (scope, factory) => idbRun(factory, 'readwrite', (s) => s.delete(String(scope)));

// --- PocketBase(端末の札で records を作る・消す) -----------------------------
/** 文字数(1字ずつ)で切る(PocketBase の max は字の数。サロゲートの片割れを残さない)。 */
const cutChars = (v, n) => Array.from(String(v == null ? '' : v)).slice(0, n).join('');
const OWNER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * 依頼・購読の持ち主(owner = ログインした端末の device_users の id)。サーバーのルールが
 * `@request.body.owner = @request.auth.id` を求める(tools/migration/pbAccess.mjs)。
 * pb.getOwner() があればそれ、無ければ札(PocketBase の JWT)の中の id。分からなければ ''。
 */
export const pbOwnerOf = (pb) => {
  try {
    const g = pb && typeof pb.getOwner === 'function' ? String(pb.getOwner() || '') : '';
    if (g) return OWNER_RE.test(g) ? g : '';
    const tok = String((pb && typeof pb.getAuth === 'function' ? pb.getAuth() : '') || '').replace(/^Bearer\s+/i, '');
    const part = tok.split('.')[1];
    if (!part) return '';
    const j = JSON.parse(new TextDecoder().decode(b64uToBytes(part)));
    const id = j && typeof j.id === 'string' ? j.id : '';
    return OWNER_RE.test(id) ? id : '';
  } catch { return ''; }
};
/** owner を付けた写し(分からない時は付けない)。 */
const withOwner = (pb, row) => {
  const o = pbOwnerOf(pb);
  const out = {};
  if (o) out.owner = o;
  for (const k in row) if (Object.prototype.hasOwnProperty.call(row, k)) out[k] = row[k];
  return out;
};
/** pb = { baseUrl, getAuth(), getOwner()?, fetchImpl? } */
const pbUrl = (pb, col, id) => String((pb && pb.baseUrl) || '').replace(/\/+$/, '') + '/api/collections/' + col + '/records' + (id ? '/' + encodeURIComponent(id) : '');
const pbSend = (pb, method, col, id, body) => {
  if (!pb || !pb.baseUrl) return Promise.reject(new Error('社内サーバー(PocketBase)の接続先がありません'));
  const f = pb.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return Promise.reject(new Error('fetch がありません'));
  const headers = { 'Content-Type': 'application/json' };
  const tok = typeof pb.getAuth === 'function' ? pb.getAuth() : '';
  if (tok) headers.Authorization = String(tok);
  return Promise.resolve(f(pbUrl(pb, col, id), { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' })).then((res) => {
    if (!res || !res.ok) throw new Error('社内サーバーへ書けません(' + (res ? res.status : '?') + ')');
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  });
};

/**
 * 送信の依頼を notify_queue へ1件(欄の名前と長さは tools/migration/pbSchema.mjs の NOTIFY_QUEUE に合わせる)。
 *  relay  … { mode, state:'new', ns, category } だけ(本文・宛先・リンクは載せない。サーバーは Teams だけ)
 *  signal … それに to(宛先の購読 = push_subs の id の並び)・title(80字)・body(300字)・link(同じ口のパスだけ・300字)
 *  ⚠signal で宛先が1つも無い時は signal の行を作らない(サーバーは to が空だと同じアプリの全端末へ送る)。
 *    呼ぶ側(sendOnpremPush)が種類だけの行(mode relay = Teams だけ・push なし)に替える。
 *  ⚠owner は enqueueNotify が付ける(札の id)。tag・requireInteraction はサーバーの欄に無いので載せない。
 */
export const buildQueueRow = ({ mode, ns, category, sids, rids, title, body, link, origin, scope }) => {
  const row = { mode: pushModeOf(mode), state: 'new', ns: String(ns || ''), category: String(category || 'info') };
  if (row.mode === PUSH_MODE_SIGNAL || row.mode === PUSH_MODE_LAN) {
    // lan … 宛先は受け取り係の id(rid・小文字と数字の15字)。形はサーバーのフック notifyQueue.pb.js も確かめる
    row.to = row.mode === PUSH_MODE_LAN
      ? (Array.isArray(rids) ? rids : []).filter((s) => RID_RE.test(String(s))).slice(0, 200)
      : (Array.isArray(sids) ? sids : []).filter((s) => SID_RE.test(String(s))).slice(0, 200);
    row.title = cutChars(title, 80);
    row.body = cutChars(body, 300);
    row.link = cutChars(safeNoticeLink(link, origin, scope || '/'), 300);
  }
  return row;
};
export const enqueueNotify = (pb, row) => pbSend(pb, 'POST', 'notify_queue', '', withOwner(pb, row));

/**
 * 社内版の送る口。中継の sendPushViaWorker と同じ形の返事({ ok, sent, results, error })。⚠投げない。
 * deps = { mode, ns, pb, origin, scope, relaySend(workerUrl, args) }
 */
export const sendOnpremPush = (deps, workerUrl, args) => {
  const d = deps || {}; const a = args || {};
  const mode = pushModeOf(d.mode);
  const category = noticeCategoryOf(a);
  const split = splitPushTokens(a.tokens);
  const origin = d.origin || '';
  if (mode === PUSH_MODE_LAN) {
    // 🔔 案A: 中継(社外)を呼ばない。宛先 = 受け取り係(lan:<rid>)だけ。⚠FCM・wp: の宛先はここでは使わない(外へ出さない)
    if (!split.rids.length) {
      return Promise.resolve()
        .then(() => enqueueNotify(d.pb, buildQueueRow({ mode: PUSH_MODE_RELAY, ns: d.ns, category: category })))
        .catch(() => null)
        .then(() => ({ ok: false, sent: 0, mode: mode, results: [], error: 'この宛先は社内の受け取り係(PC)で送れる端末ではありません(通知の方式を切り替えた後は、その PC でもう一度登録してください)' }));
    }
    const lrow = buildQueueRow({ mode: mode, ns: d.ns, category: category, rids: split.rids, title: a.title, body: a.body, link: a.link, origin: origin, scope: d.scope });
    return Promise.resolve()
      .then(() => enqueueNotify(d.pb, lrow))
      .then(() => ({ ok: true, sent: lrow.to.length, queued: true, mode: mode, results: [] }),
        (e) => ({ ok: false, sent: 0, mode: mode, results: [], error: (e && e.message) || String(e) }));
  }
  if (mode === PUSH_MODE_SIGNAL) {
    if (!split.sids.length) {
      // 宛先なし: 全端末へ広がらないよう signal の行は作らず、Teams の為の種類だけの行(push なし)にする。⚠投げない。
      return Promise.resolve()
        .then(() => enqueueNotify(d.pb, buildQueueRow({ mode: PUSH_MODE_RELAY, ns: d.ns, category: category })))
        .catch(() => null)
        .then(() => ({ ok: false, sent: 0, mode: mode, results: [], error: 'この宛先は社内の通知(signal)で送れる端末ではありません(通知の方式を切り替えた後は、端末でもう一度登録してください)' }));
    }
    const row = buildQueueRow({ mode: mode, ns: d.ns, category: category, sids: split.sids, title: a.title, body: a.body, link: a.link, origin: origin, scope: d.scope });
    return Promise.resolve()
      .then(() => enqueueNotify(d.pb, row))
      .then(() => ({ ok: true, sent: row.to.length, queued: true, mode: mode, results: [] }),
        (e) => ({ ok: false, sent: 0, mode: mode, results: [], error: (e && e.message) || String(e) }));
  }
  // relay: 今の中継はそのまま(宛先は FCM の token だけ)。種類だけの行は横で入れる(失敗しても待たない・止めない)。
  Promise.resolve().then(() => enqueueNotify(d.pb, buildQueueRow({ mode: mode, ns: d.ns, category: category }))).catch(() => null);
  if (!workerUrl || !split.fcm.length || typeof d.relaySend !== 'function') {
    return Promise.resolve({ ok: false, sent: 0, mode: mode, results: [], error: !workerUrl ? '中継(Worker)の住所が未設定です' : 'この宛先は中継で送れる端末ではありません(通知の方式を切り替えた後は、端末でもう一度登録してください)' });
  }
  const out = {};
  for (const k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
  out.tokens = split.fcm;
  return Promise.resolve().then(() => d.relaySend(workerUrl, out)).catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
};

/** 通知を送れる設定か(画面の「準備できているか」)。relay = VAPID 鍵と中継の住所 / signal・lan = いつも(送るのは社内サーバー)。 */
export const onpremPushReady = (mode, cfg) => (pushModeOf(mode) !== PUSH_MODE_RELAY ? true : !!(cfg && cfg.vapidKey && cfg.workerUrl));

// --- 🔔 案A: PC の受け取り係(lan) ------------------------------------------------
/** 受け取り係の rid を覚える場所(localStorage・この PC のこのブラウザ)。rid は秘密ではない(宛先の名前)。 */
export const LAN_RID_KEY = 'onpremLanRid';
export const LAN_NO_RECEIVER = 'この PC に受け取り係が入っていません(5_端末を足す のフォルダの『受け取り係を入れる.bat』)';
const storageOf = (s) => {
  if (s) return s;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
};
/** 覚えた rid(形が違えば '')。 */
export const getLanRid = (storage) => {
  try {
    const s = storageOf(storage);
    const v = s ? String(s.getItem(LAN_RID_KEY) || '') : '';
    return RID_RE.test(v) ? v : '';
  } catch { return ''; }
};
/**
 * 画面の住所の #lanrid=<rid> を覚えて、住所の # から消す(受け取り係を入れた時に開く画面・設計 §2.2)。
 *   env = { location, history, storage }(無ければ画面の物)。@returns 覚えた rid か ''(形の違う rid は覚えないが # からは消す)
 */
export const captureLanRid = (env) => {
  const e = env || {};
  const loc = e.location || (typeof location !== 'undefined' ? location : null);
  const hist = e.history || (typeof history !== 'undefined' ? history : null);
  const hash = loc ? String(loc.hash || '') : '';
  if (hash.indexOf('lanrid=') < 0) return '';
  const rest = []; let rid = '';
  const parts = hash.replace(/^#/, '').split('&');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].indexOf('lanrid=') === 0) { const v = parts[i].slice(7); if (RID_RE.test(v)) rid = v; } else if (parts[i]) rest.push(parts[i]);
  }
  if (rid) {
    try { const s = storageOf(e.storage); if (s) s.setItem(LAN_RID_KEY, rid); else rid = ''; } catch { rid = ''; }
  }
  try {
    if (hist && typeof hist.replaceState === 'function') hist.replaceState(hist.state, '', String(loc.pathname || '') + String(loc.search || '') + (rest.length ? '#' + rest.join('&') : ''));
  } catch { /* 消せなくても覚えた rid は使える */ }
  return rid;
};
/** lan の登録: 覚えた rid があれば token "lan:"+rid。無ければ Error(画面に出す文)。 */
export const enableLanPush = (rid) => (RID_RE.test(String(rid || '')) ? Promise.resolve(LAN_TOKEN_PREFIX + rid) : Promise.reject(new Error(LAN_NO_RECEIVER)));

/** この端末で signal の通知を使えない理由(空 = 使える見込み)。 */
export const signalSupportProblem = (env) => {
  const e = env || {};
  const w = e.window || (typeof window !== 'undefined' ? window : null);
  const nav = e.navigator || (typeof navigator !== 'undefined' ? navigator : null);
  if (!w || !nav) return '未対応の環境です';
  if (w.isSecureContext === false) return 'https でないため通知を使えません(社内サーバーの https の入口から開いてください)';
  if (!nav.serviceWorker) return 'このブラウザは通知に対応していません(Chrome/Edge/Safari の新しい物を使ってください)';
  if (!('PushManager' in w)) return 'このブラウザは Web Push に対応していません(iPhone/iPad は「ホーム画面に追加」したアイコンから開きます)';
  if (!('Notification' in w)) return 'このブラウザは通知に対応していません';
  return '';
};

/** サーバーの VAPID 公開鍵を読む(GET /__push/v1/config・Cookie を付けない)。 */
export const fetchPushServerKey = ({ fetchImpl, origin }) => Promise.resolve()
  .then(() => (fetchImpl || fetch)(pushApiUrl(origin, 'config'), { method: 'GET', credentials: 'omit', cache: 'no-store' }))
  .then((res) => {
    if (!res || !res.ok) throw new Error('社内サーバーの通知の設定を読めません(' + (res ? res.status : '?') + ')。管理者に「通知の送信係」が動いているか確認してください');
    return res.json();
  })
  .then((j) => {
    const k = String((j && (j.publicKey || j.vapidPublicKey)) || '').trim();
    if (!isVapidPublicKey(k)) throw new Error('社内サーバーの通知の鍵の形がおかしいです(管理者に確認してください)');
    return k;
  });

/**
 * signal の受信登録。成功で push_tokens に入れる token("wp:"+sid)。失敗は Error(画面に出す文)。
 * deps = { pb, ns, origin, fetchImpl, registerSw() → Promise<registration>, requestPermission(), idbFactory, cryptoImpl }
 */
export const enableSignalPush = (deps) => {
  const d = deps || {};
  let reg = null; let keyBytes = null; let j = null; let secret = '';
  return fetchPushServerKey({ fetchImpl: d.fetchImpl, origin: d.origin })
    .then((k) => { keyBytes = b64uToBytes(k); return d.registerSw(); })
    .then((r) => {
      reg = r;
      if (!reg || !reg.pushManager) throw new Error('通知の受け口(Service Worker)を用意できませんでした。開き直してもう一度押してください');
      return d.requestPermission();
    })
    .then((perm) => {
      if (perm !== 'granted') throw new Error('通知が許可されませんでした。端末/ブラウザの設定でこのサイトの通知を「許可」にしてください(通知ヘルプ参照)');
      return reg.pushManager.getSubscription();
    })
    .then((old) => {
      // 鍵が変わった古い購読は外してから作る(同じ鍵ならそのまま使う)
      const oldKey = old && old.options && old.options.applicationServerKey;
      if (old && !sameBytes(oldKey, keyBytes)) return Promise.resolve(old.unsubscribe()).catch(() => null).then(() => null);
      return old;
    })
    .then((old) => old || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes }))
    .then((s) => {
      j = (s && typeof s.toJSON === 'function') ? s.toJSON() : null;
      if (!j || !isAllowedPushEndpoint(j.endpoint) || !j.keys || !j.keys.p256dh || !j.keys.auth) {
        return Promise.resolve(s && s.unsubscribe && s.unsubscribe()).catch(() => null).then(() => { throw new Error('このブラウザの通知の宛先が、許した送り先(Chrome/Edge/Safari の通知の口)ではありません'); });
      }
      return idbGetSub(reg.scope, d.idbFactory).catch(() => null);
    })
    .then((saved) => {
      if (saved && saved.sid && saved.secret && saved.endpoint === j.endpoint && saved.ns === String(d.ns || '')) return saved.sid;
      secret = randomSecret(d.cryptoImpl);
      return sha256Hex(secret, d.cryptoImpl)
        .then((hash) => pbSend(d.pb, 'POST', 'push_subs', '', withOwner(d.pb, { ns: String(d.ns || ''), endpoint: j.endpoint, secretHash: hash })))
        .then((rec) => {
          const sid = rec && rec.id;
          if (!sid || !SID_RE.test(String(sid))) throw new Error('社内サーバーの返事に宛先の番号がありません');
          return idbPutSub(reg.scope, { sid: String(sid), secret: secret, endpoint: j.endpoint, ns: String(d.ns || ''), at: Date.now() }, d.idbFactory).then(() => String(sid));
        });
    })
    .then((sid) => WP_TOKEN_PREFIX + sid, (e) => { throw (e instanceof Error ? e : new Error(String(e))); });
};

/** signal の受信を止める(購読を外す・IndexedDB を消す・push_subs を消してみる)。⚠失敗しても投げない。 */
export const disableSignalPush = (deps) => {
  const d = deps || {};
  let reg = null; let saved = null;
  return Promise.resolve()
    .then(() => d.registerSw())
    .then((r) => { reg = r; return reg ? idbGetSub(reg.scope, d.idbFactory).catch(() => null) : null; })
    .then((s) => { saved = s; return reg && reg.pushManager ? reg.pushManager.getSubscription() : null; })
    .then((sub) => (sub ? sub.unsubscribe() : null)).catch(() => null)
    .then(() => (reg ? idbDeleteSub(reg.scope, d.idbFactory).catch(() => null) : null))
    .then(() => (saved && saved.sid ? pbSend(d.pb, 'DELETE', 'push_subs', saved.sid).catch(() => null) : null))
    .then(() => undefined, () => undefined);
};

/**
 * 1つのアプリの社内版の通知の口をまとめて作る(各アプリの社内版の部品が呼ぶ)。
 * deps = { getMode(), ns, getPb(), getOrigin(), getScope(), relaySend, relayEnable, relayDisable, relayListen,
 *          relayProblem(), registerSw(), requestPermission(), fetchImpl?, idbFactory?, cryptoImpl? }
 */
export const createOnpremPush = (deps) => {
  const d = deps || {};
  const mode = () => pushModeOf(typeof d.getMode === 'function' ? d.getMode() : d.mode);
  const origin = () => (typeof d.getOrigin === 'function' ? d.getOrigin() : (typeof location !== 'undefined' ? location.origin : ''));
  const sigDeps = () => ({
    pb: typeof d.getPb === 'function' ? d.getPb() : d.pb, ns: d.ns, origin: origin(), fetchImpl: d.fetchImpl,
    registerSw: d.registerSw, requestPermission: d.requestPermission, idbFactory: d.idbFactory, cryptoImpl: d.cryptoImpl,
  });
  const lanRid = () => (typeof d.getLanRid === 'function' ? d.getLanRid() : getLanRid(d.storage));
  return {
    mode: mode,
    ready: (cfg) => onpremPushReady(mode(), cfg),
    supportProblem: () => (mode() === PUSH_MODE_LAN ? (lanRid() ? '' : LAN_NO_RECEIVER)
      : (mode() === PUSH_MODE_SIGNAL ? signalSupportProblem(d.env) : (typeof d.relayProblem === 'function' ? d.relayProblem() : ''))),
    send: (workerUrl, args) => sendOnpremPush({
      mode: mode(), ns: d.ns, pb: typeof d.getPb === 'function' ? d.getPb() : d.pb, origin: origin(),
      scope: typeof d.getScope === 'function' ? d.getScope() : '', relaySend: d.relaySend,
    }, workerUrl, args),
    enable: (vapidKey) => (mode() === PUSH_MODE_LAN ? enableLanPush(lanRid())
      : (mode() === PUSH_MODE_SIGNAL ? enableSignalPush(sigDeps()) : d.relayEnable(vapidKey))),
    // lan の解除は push_tokens の行を消すだけ(呼ぶ側の 🔔 の画面が消す)。受け取り係はその PC に残る
    disable: () => (mode() === PUSH_MODE_LAN ? Promise.resolve()
      : (mode() === PUSH_MODE_SIGNAL ? disableSignalPush(sigDeps()) : d.relayDisable())),
    // signal の時は画面を開いていても SW が通知を出す(Firebase の onMessage は使わない)・lan は PC の受け取り係が出す
    listenForeground: (handler) => (mode() !== PUSH_MODE_RELAY ? Promise.resolve(() => {}) : d.relayListen(handler)),
  };
};
