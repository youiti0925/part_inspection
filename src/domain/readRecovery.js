// 目的: 「読めていません」 帯の自動回復: サーバに届かない時は赤でなく穏やかな帯を出し、つながったら自分で読み直して帯を消す。
// 入力: 読めなかった理由・online の状態・読み直しの係(onRetry)・間隔の設定。
// 出力: 帯の種類(readBandKind)・オフラインの帯の文・自動読み直しの開始/停止・サーバから本当に読めたかの判定。
// 呼ぶ人: src/App.jsx(社内版の時だけ)。
// 触る外の物: ブラウザの online の合図とタイマーだけ。DOM も firebase も import しない。
// 確かめ方: npm test(src/domain/__tests__/readRecovery.test.mjs)・社内版でサーバを切って画面を開き、戻して帯が消える事。
// ============================================================================
// 🔁 社内版(PocketBase): 「読めていません」の帯を、つながったら自分で消す(R39・2026-10-31)
// ----------------------------------------------------------------------------
// 何が困っていたか:
//   サーバに届かない間に、まだ一度も読めていない一覧(例: education_events)を開くと、
//   赤い帯「🚨 データが読めていません…再読み込みしてください」が出て、
//   **つながった後も出たまま**(誰も読み直さない)。清水さんの決定(2):
//   「サーバから読めない時は落とさず、端末の控えを出す」。
// 形:
//   ① 読めない理由が「つながらない」だけなら、赤ではなく穏やかな帯
//      「サーバにつながっていません(この端末の控えを表示しています)」を出す(readBandKind)。
//   ② つながった合図(ブラウザの online)と、一定の間隔(既定15秒)で、読めなかった物を自動で読み直す
//      (startReadRecovery)。⚠読めていない物が無い時・枠切れ(429)の時は何もしない(isActive)。
//   ③ 帯を消すのは **サーバから本当に読めた** 合図が届いた時だけ(各アプリの受け口・fromCache で見分ける)。
//      読み直しが失敗した時は消さない(消して出してを繰り返さない)。ロットの保存の門も同じ合図で開く。
// ⚠このファイルは社内版のビルドだけが使う(いつものビルドでは使う所が畳まれ、出力に入らない)。
// ⚠DOM も firebase も import しない(Node の試験で読めるように)。4アプリで同じ中身。
// ============================================================================

/** 自動で読み直す間隔(ミリ秒)。送信待ちの箱(outbox)の見回りと同じ15秒。 */
export const READ_RETRY_INTERVAL_MS = 15000;

// 「つながらない」と言える理由。PocketBase の窓口(pbClient)の通信失敗・入口(https-front)の 502/503/504・
// ブラウザの fetch 失敗・Firestore の unavailable。⚠権限・ログイン・形の誤りはここに入れない(赤のまま)。
const NET_RE = /PocketBase 通信失敗|PocketBase 50[234]\b|Failed to fetch|NetworkError|Load failed|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|^unavailable$/i;

/** 読めなかった理由(文字・例外)が「サーバにつながらない」か。 */
export const isConnectionLost = (reason) => {
  if (reason == null) return false;
  if (typeof reason === 'object') {
    if (reason.name === 'PbNetworkError') return true;
    const st = Number(reason.status);
    if (st === 502 || st === 503 || st === 504) return true;
    return NET_RE.test(String(reason.code || '')) || NET_RE.test(String(reason.message || ''));
  }
  return NET_RE.test(String(reason));
};

/**
 * 帯の種類。
 * @param errors  { 名札: 理由 } (読めていない物だけ)
 * @param online  ブラウザが「つながっている」と言っているか(navigator.onLine)
 * @returns 'none'(出さない) / 'offline'(穏やかな帯: 控えを表示中・自動で読み直す) / 'error'(赤い帯)
 */
export const readBandKind = (errors, { online = true } = {}) => {
  const vals = Object.values(errors || {});
  if (!vals.length) return 'none';
  if (online === false) return 'offline';
  return vals.every(isConnectionLost) ? 'offline' : 'error';
};

/** 穏やかな帯の文。⚠保存を止めていない時に「止めています」と書かない(嘘になる)。 */
export const OFFLINE_BAND_TITLE = '📴 サーバにつながっていません（この端末に残っている控えを表示しています）';
export const offlineBandDetail = ({ saveStopped = false } = {}) =>
  'つながると自動で読み直して、この帯は消えます。'
  + (saveStopped ? 'ロットの保存は、読み直せるまで止めています（検査記録を空で上書きしないため）。' : '');

/**
 * 自動の読み直しを始める。戻り値は止める関数。
 * @param win        window(addEventListener を持つ物)。無ければ間隔だけ
 * @param onRetry    読み直す処理(各アプリの「張り直す」・「読み直す」)
 * @param isActive   今読み直してよいか(読めていない物があり、枠切れでない)。false の間は何もしない
 * @param intervalMs 間隔
 * @param timers     { setInterval, clearInterval }(試験で差し替える)
 */
export const startReadRecovery = ({ win = null, onRetry, isActive = () => true, intervalMs = READ_RETRY_INTERVAL_MS, timers = null } = {}) => {
  if (typeof onRetry !== 'function') return () => {};
  const T = timers || { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h) };
  let stopped = false;
  let busy = false;   // ⚠前の読み直しが終わる前に次を重ねない(遅いサーバに同じ問い合わせを積まない)
  const fire = (why) => {
    if (stopped || busy) return;
    let ok = false;
    try { ok = !!isActive(); } catch { ok = false; }
    if (!ok) return;
    let r;
    try { r = onRetry(why); } catch (e) { console.warn('[読み直し] 失敗しました(次の機会にもう一度)', e); return; }
    if (r && typeof r.then === 'function') {
      busy = true;
      r.then(() => { busy = false; }, (e) => { busy = false; console.warn('[読み直し] 失敗しました(次の機会にもう一度)', e); });
    }
  };
  const onOnline = () => fire('online');
  if (win && typeof win.addEventListener === 'function') win.addEventListener('online', onOnline);
  const iv = T.setInterval(() => fire('interval'), intervalMs);
  return () => {
    stopped = true;
    if (win && typeof win.removeEventListener === 'function') win.removeEventListener('online', onOnline);
    T.clearInterval(iv);
  };
};

/** 受け取った snapshot が「まだサーバから読めていない(端末の控えだけ)」か。PocketBase は一度もサーバから読めていない間 true。 */
export const isLocalOnlySnap = (snap) => !!(snap && snap.metadata && snap.metadata.fromCache);

/**
 * 1つの置き場所を、サーバから読めるか確かめながら読み直す(PocketBase では読めていない一覧を読みに行く)。
 * ⚠読めたら、同じ置き場所を購読している画面の受け口へも、サーバの答えが届く(保管庫が全員へ配る)。
 * @param P   保管庫の窓口(DATA(db))。watchDoc を持つ物
 * @returns Promise<{ ok: boolean, why? }>  ok = サーバの答え(fromCache でない合図)が届いた
 */
export const probeServerRead = (P, ns, col, { timeoutMs = 20000, timers = null } = {}) => new Promise((resolve) => {
  const T = timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h) };
  let done = false;
  let un = null;
  let t = null;
  const finish = (ok, why) => {
    if (done) return;
    done = true;
    if (t != null) T.clearTimeout(t);
    if (un) { try { un(); } catch { /* 既に外れていても構わない */ } }
    resolve(ok ? { ok: true } : { ok: false, why });
  };
  t = T.setTimeout(() => finish(false, 'timeout'), timeoutMs);
  try {
    un = P.watchDoc(ns, col, '__read_probe__', (_d, snap) => { if (!isLocalOnlySnap(snap)) finish(true); }, { onError: (e) => finish(false, e) });
  } catch (e) { finish(false, e); }
  if (done && un) { try { un(); } catch { /* 同上 */ } }
});

/**
 * 帯の名札 → 読み直す置き場所 [ns, col]。
 * ⚠名札は「lots(過去)」の様に (…) が付く事がある(同じ置き場所の別の窓)。付いていれば外す。
 * @param aliases  { 名札: [ns, col] }(別の領域の物・名札と置き場所の名前が違う物)
 */
export const readTargetOf = (key, appNs, aliases = {}) => {
  const k = String(key == null ? '' : key);
  if (Object.prototype.hasOwnProperty.call(aliases, k)) return aliases[k];
  return [appNs, k.replace(/\(.*\)$/, '')];
};
