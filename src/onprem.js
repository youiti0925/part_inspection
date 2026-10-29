// ============================================================================
// 社内サーバ版(オンプレ)のスイッチ — 2026-10-29
// ----------------------------------------------------------------------------
// ⚠⚠ スイッチは **ビルドの時の1つだけ**: VITE_ONPREM=1(npm run build:onprem が .env.onprem から入れる)。
//   スイッチが無いビルド(= いつもの本番)では、このファイルの関数は何もしない。
//   本番の動き(Firebase・匿名ログイン・Storage・通知)は1つも変わらない。
//
// スイッチが入ったビルドでは:
//   ・Firebase を1つも起こさない(initializeApp・匿名ログイン・Firestore・Storage・FCM を呼ばない)
//   ・保管庫は全部の領域(検査・写真・分析・年間目標・連絡・通知の宛先)を PocketBase へ
//   ・PocketBase の行き先は、index.html の横に置いた onprem-config.json を最初に読んで決める
//     (url が無ければビルドの時の VITE_PB_URL。端末用アカウントは設定ファイルにだけ書く)
//   ・プッシュ通知は使わない(push.js が「社内版では通知を使いません」を返す)
//
// ⚠ここには firebase も pocketbase も import しない(node の試験で読めるように)。
// ============================================================================

// ⚠ import.meta.env を丸ごと使わない(丸ごと書くと Vite が全部の VITE_ の値をバンドルへ入れる)。要る鍵だけを1つずつ書く。
//   node の試験では import.meta.env が無いので、読めなければ空(= 社内版ではない)。
// ⚠ 2026-10-30 下の定数は Object.freeze で包まない(包むと「呼び出し」が残り、いつものビルドの出力に社内版の字が残る・
//   /* @__PURE__ */ を付けても消えなかった)。中身を書き換える所は無い(dataRoute.js は差し替えるだけ)。
const readEnv = () => {
  try {
    return {
      VITE_PB_URL: import.meta.env.VITE_PB_URL,
      VITE_PB_AUTH_COLLECTION: import.meta.env.VITE_PB_AUTH_COLLECTION,
    };
  } catch { return {}; }
};

/** このビルドが社内サーバ版か。node の試験では import.meta.env が無いので必ず false。
 *  ⚠ 2026-10-30 ビルドの時の定数 __ONPREM__(vite.config.js の define)で決める。いつものビルドでは字面が false に
 *    置き換わるので、社内版だけの道(Firebase を起こさない分かれ道・設定ファイルの読み)は本番の出力から消える。
 *    node の試験では __ONPREM__ が無い(typeof が undefined)ので false。 */
// eslint-disable-next-line no-undef -- __ONPREM__ は vite.config.js の define がビルドの時に置き換える
export const IS_ONPREM_BUILD = typeof __ONPREM__ !== 'undefined' && __ONPREM__ === true;

/** 社内サーバ版の保管庫。⚠連絡と通知の宛先も PocketBase(Firebase へは1件も行かせない)。 */
export const ONPREM_PROVIDERS = {
  inspection: 'pocketbase',
  attachments: 'pocketbase',
  analytics: 'pocketbase',
  goals: 'pocketbase',
  contact: 'pocketbase',
  push: 'pocketbase',
};

/** index.html の横に置く設定の名前(相対パス = アプリを置いた場所から読む)。 */
export const ONPREM_CONFIG_FILE = 'onprem-config.json';

/**
 * Firestore の db の代わりに窓口へ渡す鍵。
 * ⚠窓口(providerFor)は db ごとに1つ作って覚える(WeakMap)ので、物(object)である事が要る。
 *   中身は使わない。Firebase の関数へは渡らない(全部の領域が PocketBase なので)。
 */
export const ONPREM_DB = { onprem: true, kind: 'onprem-db-key' };

/** user の代わり。画面は user を「読み込みを始めてよいか」の印にしか使っていない(user. の参照は0件)。 */
export const ONPREM_USER = { uid: 'onprem', isAnonymous: false, onprem: true };

const trimUrl = (v) => String(v || '').trim().replace(/\/+$/, '');

/**
 * 設定ファイルの中身とビルドの時の値を1つにまとめる(純関数)。
 * ⚠設定ファイルが優先(サーバの置き場所が変わってもビルドし直さずに済むように)。
 * @param json  onprem-config.json の中身(読めなければ null)
 * @param env   import.meta.env の写し({VITE_PB_URL, VITE_PB_AUTH_COLLECTION})
 * @returns { ok, url, email, password, authCollection, appUrls, source, problems[] }
 */
export const normalizeOnpremConfig = (json, env = {}) => {
  const j = (json && typeof json === 'object' && !Array.isArray(json)) ? json : {};
  // ⚠ 2026-10-30 4アプリ共通の形: 鍵は一番上に {url, email, password, authCollection, appUrls?}。
  //   前の見本の形({ pocketbase: {...} })も読む(一番上に無い鍵だけ、そちらから拾う)。
  const nested = (j.pocketbase && typeof j.pocketbase === 'object' && !Array.isArray(j.pocketbase)) ? j.pocketbase : {};
  const pick = (k) => (j[k] !== undefined && j[k] !== null && j[k] !== '' ? j[k] : nested[k]);
  const pb = { url: pick('url'), email: pick('email'), password: pick('password'), authCollection: pick('authCollection') };
  const appUrls = (j.appUrls && typeof j.appUrls === 'object' && !Array.isArray(j.appUrls))
    ? Object.fromEntries(Object.entries(j.appUrls).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]))
    : {};
  const url = trimUrl(pb.url || env.VITE_PB_URL);
  // ⚠ 端末用アカウントは設定ファイルからだけ読む。VITE_ の値はビルドで JS へ焼き込まれるので、
  //   合言葉を VITE_ に置かない決まり(scripts/verify-no-browser-api-key.mjs が見張っている)。
  const email = String(pb.email || '');
  const password = String(pb.password || '');
  const authCollection = String(pb.authCollection || env.VITE_PB_AUTH_COLLECTION || 'device_users');
  const problems = [];
  if (!url) problems.push(`PocketBase の行き先がありません(${ONPREM_CONFIG_FILE} の url か、ビルドの時の VITE_PB_URL を入れてください)`);
  else if (!/^https?:\/\//i.test(url)) problems.push(`PocketBase の行き先が http(s):// で始まっていません: ${url}`);
  if (!email || !password) problems.push(`端末用アカウント(email と password)がありません(${ONPREM_CONFIG_FILE} の email と password に書いてください)。ログインできないので読み書きできません`);
  const source = pb.url ? 'config' : (env.VITE_PB_URL ? 'env' : 'none');
  return { ok: problems.length === 0, url, email, password, authCollection, appUrls, source, problems };
};

/**
 * 設定ファイルを読む。⚠読めない(404・形が違う)時も投げない。ビルドの時の値で続ける。
 * @param fetchImpl  試験で差し替える
 */
// ⚠ 2026-10-30 async を書かずに Promise で書く。古い Safari 向けの変換(es2015)で async は「すぐ呼ぶ包み」になり、
//   いつものビルドで使われなくても出力に残る(社内版の字が本番の dist に残っていた)。中身・返す物は前と同じ。
export const loadOnpremConfig = ({ fetchImpl, env = readEnv(), path = ONPREM_CONFIG_FILE } = {}) => {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const fail = (why) => ({ json: null, readProblem: `${path} が読めません(${why})` });
  const read = !f ? Promise.resolve({ json: null, readProblem: '' })
    : Promise.resolve()
      .then(() => f(path, { cache: 'no-store' }))
      .then((res) => ((res && res.ok)
        ? Promise.resolve(res.json()).then((json) => ({ json, readProblem: '' }))
        : fail(res ? res.status : '返事なし')))
      .catch((e) => fail((e && e.message) || e));
  return read.then(({ json, readProblem }) => ({ ...normalizeOnpremConfig(json, env), readProblem }));
};

/** 窓口へ渡す PocketBase の接続設定(connectPocketbase.js が受け取る形)。 */
export const pbConfigOfOnprem = (cfg, extra = {}) => ({
  url: cfg.url,
  email: cfg.email,
  password: cfg.password,
  authCollection: cfg.authCollection || 'device_users',
  owner: extra.owner || '',
  onPendingChange: extra.onPendingChange,
  onConflict: extra.onConflict,
  onAuthError: extra.onAuthError,
});

/** 社内版ではプッシュ通知を使わない時の文言(push.js・連絡の画面で同じ字を出す)。 */
export const ONPREM_PUSH_OFF = '社内版では通知を使いません(画面のバッジで確認してください)';
