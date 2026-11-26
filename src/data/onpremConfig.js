// 目的: 「社内サーバ版の起動の設定」 onprem-config.json の読み方・端末用アカウントの覚え方・全部を PocketBase にする保管庫の決め方。
// 入力: onprem-config.json の中身・ビルド時の値(VITE_PB_URL など)・端末に覚えたアカウント(localStorage 相当)。
// 出力: 使う形の設定(parseOnpremConfig)・領域ごとの保管庫の表(ONPREM_PROVIDERS)・読み書きの小さい関数。
// 呼ぶ人: 社内版の起動(src/onprem/ の起動の部品)・試験(src/data/__tests__/onpremConfig.test.mjs)。
// 触る外の物: 設定ファイルの読み込み(fetchOnpremConfig)と、渡された保管場所(storage)への端末アカウントの書き消しだけ。firebase も DOM も import しない。
// 確かめ方: npm test(src/data/__tests__/onpremConfig.test.mjs)。
// ============================================================================
// 社内サーバ(オンプレ)用の切替 — 設定の読み方と保管庫の決め方(2026-10-29 G1/G3)
// ----------------------------------------------------------------------------
// 何のため:
//   インターネットの無い社内LANでも、Firebase を1つも使わずに起動できるようにする。
//   今までは保存先の切替が「Firestore から読んだ settings.pocketbase を端末に覚え、
//   次に開いた時に効く」作りだけで、Firebase の匿名ログインが通らないと何も読めなかった。
//
// 使い方(アプリ側):
//   ビルド時に VITE_ONPREM=1 を渡した時だけ、vite.config.js が __ONPREM__ を true にする。
//   true の時だけ src/onprem/boot.jsx がこのファイルを使い、
//     ① index.html の隣の onprem-config.json を読む(無ければビルド時の VITE_PB_URL)
//     ② 端末用アカウントは設定ファイル → 無ければ端末に覚えた物(初回に画面で入れる)
//     ③ 全部の領域を PocketBase にする(連絡も。通知は FCM を使わない)
//   ⚠__ONPREM__ が false(今の本番ビルド)の時は、このファイルはどこからも使われず、
//     ビルドの中にも入らない(Vite が定数で置き換えて枝ごと消す)。
//
// ⚠このファイルは firebase も DOM も import しない(Node の試験で読めるように)。
// ⚠管理者(superuser)の資格情報を設定ファイルに書かないこと。端末用の普通のアカウントだけ。
// ============================================================================

import { AREAS } from './routes.js';

/** 社内サーバの時の保管庫: **全部 PocketBase**。
 *  ⚠通知(push)の置き場(push_tokens)も PocketBase に置く(Firebase に1件も触らない為)。
 *    携帯へ鳴らす FCM は社内では使えないので、送る・受ける側は push.js が止める。 */
export const ONPREM_PROVIDERS = Object.freeze(Object.fromEntries(AREAS.map((a) => [a, 'pocketbase'])));

/** onprem-config.json の置き場(index.html と同じ階層)。 */
export const ONPREM_CONFIG_FILE = 'onprem-config.json';
/** 端末に覚える端末用アカウント(設定ファイルに書かない運用の時に使う)。 */
export const ONPREM_DEVICE_KEY = 'onprem.device.v1';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 設定の中身を確かめて、使う形にする。
 * @param raw       onprem-config.json の中身(無ければ null)
 * @param build     ビルド時の値 { url: VITE_PB_URL, authCollection: VITE_PB_AUTH_COLLECTION }
 * @param device    端末に覚えた { email, password }(無ければ null)
 * @returns { ok, url, authCollection, email, password, owner, errors[], needsLogin, source }
 *   ok=false … 接続先が無い・形がおかしい(起動しない。理由を画面に出す)
 *   needsLogin=true … 接続先はあるが端末用アカウントが無い(初回の入力画面を出す)
 */
export const parseOnpremConfig = (raw, build = {}, device = null) => {
  const errors = [];
  const hasFile = !!(raw && typeof raw === 'object' && !Array.isArray(raw));
  const cfg = hasFile ? raw : {};
  // 🏢 2026-10-30 設定ファイルの url が空・書いていない = **画面と同じ口(オリジン)**。入口(https-front)が
  //   各アプリの口の /api/ を PocketBase へ渡すので、住所を書くのは appUrls だけで済む。
  //   ⚠設定ファイルが無い時は同じ口にしない(端末用アカウントも無いので、ビルド時の VITE_PB_URL か「無い」と言う)。
  const origin = str(build.origin).replace(/\/+$/, '');
  const sameOrigin = hasFile && !str(cfg.url) && /^https?:\/\/[^\s/]+/i.test(origin);
  const url = (str(cfg.url) || (sameOrigin ? origin : '') || str(build.url)).replace(/\/+$/, '');
  const source = str(cfg.url) ? ONPREM_CONFIG_FILE : (sameOrigin ? 'same-origin' : (str(build.url) ? 'VITE_PB_URL' : ''));
  if (!url) errors.push(`接続先がありません(${ONPREM_CONFIG_FILE} の url か、ビルド時の VITE_PB_URL)`);
  else if (!/^https?:\/\/[^\s/]+/i.test(url)) errors.push(`接続先の形がおかしいです: ${url}(http:// か https:// で始めてください)`);
  const authCollection = str(cfg.authCollection) || str(build.authCollection) || 'device_users';
  if (!/^[A-Za-z0-9_]+$/.test(authCollection)) errors.push(`authCollection の形がおかしいです: ${authCollection}`);
  // ⚠設定ファイルに書いてあればそれを使う。無ければ端末に覚えた物。どちらも無ければ初回の入力。
  const fromFile = !!(str(cfg.email) && typeof cfg.password === 'string' && cfg.password);
  const dev = (device && typeof device === 'object') ? device : {};
  const email = fromFile ? str(cfg.email) : str(dev.email);
  const password = fromFile ? cfg.password : (typeof dev.password === 'string' ? dev.password : '');
  // 送信待ちの箱の持ち主(端末ごとに分ける)。⚠空でも動く(既定の箱)。
  const owner = str(cfg.owner) || str(dev.owner) || '';
  const ok = errors.length === 0;
  // 🔔 2026-10-31 通知の方式: "relay"(書かない時 = 今の中継) | "signal"(社内の Web Push) | "lan"(2026-11-09 案A・PC の受け取り係・社内版の一式の既定)。
  //   webPushClient.js の pushModeOf と同じ決め方。
  const pushModeRaw = String(cfg.pushMode == null ? '' : cfg.pushMode).trim().toLowerCase();
  const pushMode = pushModeRaw === 'signal' || pushModeRaw === 'lan' ? pushModeRaw : 'relay';
  return { ok, url, authCollection, email, password, owner, pushMode, errors, needsLogin: ok && !(email && password), source,
    credentialsFrom: fromFile ? 'file' : (email && password ? 'device' : '') };
};

/**
 * 保管庫の窓口に渡す形(providerFor の第3・第4引数)。
 * ⚠pbConfig の形は App の applyDataRoute が作る物と同じ(connectPocketbase.js が受け取る)。
 */
export const onpremRoute = (parsed, extra = {}) => {
  if (!parsed || !parsed.ok) throw new Error('社内サーバの設定が正しくありません: ' + ((parsed && parsed.errors) || []).join(' / '));
  return {
    providers: ONPREM_PROVIDERS,
    pbConfig: {
      url: parsed.url, email: parsed.email, password: parsed.password, authCollection: parsed.authCollection,
      owner: extra.owner || parsed.owner || '', onPendingChange: extra.onPendingChange, onConflict: extra.onConflict,
      onAuthError: extra.onAuthError,
    },
    // ⚠先頭は 'PocketBase' で始める(画面の帯はこの文字で始まる時だけ保存先を出す)
    note: `PocketBase(${parsed.url}) ※社内サーバ: 連絡も含め全部の保存先。携帯へのプッシュ通知は使いません`,
  };
};

/**
 * 設定ファイルを読む。⚠通信しない試験の為に fetch を渡せる。
 * ⚠無い時(404)・SPA の決まりで index.html が返ってきた時(JSON でない)は null(=ビルド時の値へ)。
 *   読めなかった理由は reason に残す(黙らない)。
 */
export const fetchOnpremConfig = async ({ fetchImpl = (typeof fetch === 'function' ? fetch : null), baseUrl = '/' } = {}) => {
  if (!fetchImpl) return { raw: null, reason: 'fetch がありません' };
  const base = String(baseUrl || '/').endsWith('/') ? String(baseUrl || '/') : `${baseUrl}/`;
  let res;
  try { res = await fetchImpl(`${base}${ONPREM_CONFIG_FILE}`, { cache: 'no-store' }); } catch (e) { return { raw: null, reason: `読めません: ${(e && e.message) || e}` }; }
  if (!res || !res.ok) return { raw: null, reason: `置かれていません(${res ? res.status : '?'})` };
  try {
    const text = await res.text();
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw: null, reason: 'JSON のオブジェクトではありません' };
    return { raw, reason: '' };
  } catch (e) {
    return { raw: null, reason: `JSON として読めません(${(e && e.message) || e})` };
  }
};

/** 端末に覚えた端末用アカウントを読む・書く。⚠localStorage が使えない端末でも落とさない。 */
export const readDeviceLogin = (storage) => {
  try { const v = JSON.parse((storage && storage.getItem(ONPREM_DEVICE_KEY)) || 'null'); return (v && typeof v === 'object') ? v : null; } catch { return null; }
};
export const writeDeviceLogin = (storage, { email, password, owner } = {}) => {
  try { storage.setItem(ONPREM_DEVICE_KEY, JSON.stringify({ email: str(email), password: String(password || ''), owner: str(owner) })); return true; } catch { return false; }
};
export const clearDeviceLogin = (storage) => { try { storage.removeItem(ONPREM_DEVICE_KEY); return true; } catch { return false; } };

/** Firebase の db の代わりに渡す印。⚠providerFor は db を WeakMap の鍵に使うのでオブジェクトである事が要る。 */
export const ONPREM_DB = Object.freeze({ __onprem: true, kind: 'onprem' });
/** Firebase の user の代わり。画面は「ログイン済みか」(真偽)しか見ていない。
 *  ⚠getIdToken は Firebase の合言葉。社内では空を返す(PocketBase の保管庫は呼ばない)。 */
export const makeOnpremUser = (email) => Object.freeze({
  uid: `onprem:${str(email) || 'device'}`, isAnonymous: false, email: str(email), onprem: true,
  getIdToken: async () => '',
});
