// ============================================================================
// 保管庫の窓口(Provider)
// ----------------------------------------------------------------------------
// PocketBase移行 Phase M1。
// 画面のコードは「Firestoreの関数」ではなく、ここだけを呼ぶ。
//
// ⚠M1では中身は Firebase そのまま。**表示・保存されるデータは1バイトも変えない。**
//   変えるのは「どこ経由で呼ぶか」だけ。
//
// ⚠firebase の import はしない。必要な関数は呼び出し側から渡す(fs)。
//   こうしないと Node のテストで読み込めず、地図(routes.js)と窓口の
//   食い違いを機械で確かめられなくなる。
// ============================================================================

import { dataPath, backendFor, DEFAULT_PROVIDERS, areaOf, isKnownCollection } from './routes.js';

// ----------------------------------------------------------------------------
// 1件を JS のオブジェクトに直す方法は **2通りある**。混ぜてはいけない。
// ⚠製品検査は本文の中にも `id` を書いている(App.jsx の保存で `{ ...rest, id }`)。
//   そのため「ドキュメントIDを優先」と「本文のidを優先」で結果が変わる。
//   既存の呼び出し元がどちらだったかを、そのまま引き継ぐこと。
// ----------------------------------------------------------------------------
export const ROW_DOCID_WINS = (d) => ({ ...d.data(), id: d.id }); // 既存: {...d.data(), id: d.id}
export const ROW_DATA_WINS = (d) => ({ id: d.id, ...d.data() });  // 既存: {id: d.id, ...d.data()}

/**
 * Firebase 版の保管庫。
 * @param db  Firestore インスタンス
 * @param fs  { collection, doc, onSnapshot, setDoc, deleteDoc, getDocs, getDoc, serverTimestamp }
 */
export const createFirebaseBackend = (db, fs) => {
  const need = (n) => { if (typeof fs?.[n] !== 'function') throw new Error(`createFirebaseBackend: fs.${n} が渡されていません`); };
  ['collection', 'doc', 'onSnapshot', 'setDoc', 'deleteDoc', 'getDocs', 'getDoc', 'serverTimestamp'].forEach(need);

  const colRef = (ns, col) => fs.collection(db, ...dataPath(ns, col));
  const docRef = (ns, col, id) => fs.doc(db, ...dataPath(ns, col, id));

  // ⚠エラー用の関数は「渡された時だけ」渡す。空の関数を勝手に足すと、
  //   今まで console に出ていた購読エラーが黙って消える。
  const listen = (ref, next, onErr) => (onErr ? fs.onSnapshot(ref, next, onErr) : fs.onSnapshot(ref, next));

  return {
    kind: 'firebase',
    raw: db,
    colRef,
    docRef,
    /** サーバ側の時刻。M1では serverTimestamp() = 今までと同じ値。 */
    now: () => fs.serverTimestamp(),
    watchCollection: (ns, col, cb, opts = {}) =>
      listen(colRef(ns, col), (snap) => cb(snap.docs.map(opts.map || ROW_DOCID_WINS), snap), opts.onError),
    watchDoc: (ns, col, id, cb, opts = {}) =>
      listen(docRef(ns, col, id), (snap) => cb(snap.exists() ? snap.data() : null, snap), opts.onError),
    getAll: async (ns, col, opts = {}) => (await fs.getDocs(colRef(ns, col))).docs.map(opts.map || ROW_DOCID_WINS),
    getOne: async (ns, col, id) => { const s = await fs.getDoc(docRef(ns, col, id)); return s.exists() ? s.data() : null; },
    save: (ns, col, id, data, opts = {}) => fs.setDoc(docRef(ns, col, id), data, { merge: opts.merge !== false }),
    remove: (ns, col, id) => fs.deleteDoc(docRef(ns, col, id)),
  };
};

/**
 * 窓口。機能領域ごとに保管庫へ振り分ける。
 * @param backends  { firebase: <createFirebaseBackend の戻り>, pocketbase?: ... }
 * @param providers { inspection:'firebase', contact:'firebase', ... }
 */
export const createProvider = ({ backends, providers = DEFAULT_PROVIDERS, onUnknownCollection } = {}) => {
  if (!backends || typeof backends !== 'object') throw new Error('createProvider: backends が必要です');

  const pick = (ns, col) => {
    if (onUnknownCollection && !isKnownCollection(ns, col)) onUnknownCollection(ns, col);
    const name = backendFor(ns, col, providers);
    const b = backends[name];
    if (!b) {
      throw new Error(
        `保管庫「${name}」がまだ用意されていません (${ns}/${col} = ${areaOf(ns, col)})。` +
        ' Phase M1 では firebase だけです。'
      );
    }
    return b;
  };

  return {
    providers,
    /** その置き場所がどの機能領域・どの保管庫か(移行の進み具合を数えるのに使う)。 */
    routeOf: (ns, col) => ({ area: areaOf(ns, col), backend: backendFor(ns, col, providers), known: isKnownCollection(ns, col) }),

    // --- 生の参照(M1のあいだだけ。runTransaction / query / updateDoc に渡す) ---
    // ⚠これらは Firestore のオブジェクトをそのまま返す。M3で最後に消す。
    colRef: (ns, col) => pick(ns, col).colRef(ns, col),
    docRef: (ns, col, id) => pick(ns, col).docRef(ns, col, id),
    now: (ns, col) => pick(ns, col).now(),

    // --- 読む ---------------------------------------------------------------
    watchCollection: (ns, col, cb, opts) => pick(ns, col).watchCollection(ns, col, cb, opts),
    watchDoc: (ns, col, id, cb, opts) => pick(ns, col).watchDoc(ns, col, id, cb, opts),
    getAll: (ns, col, opts) => pick(ns, col).getAll(ns, col, opts),
    getOne: (ns, col, id) => pick(ns, col).getOne(ns, col, id),

    // --- 書く ---------------------------------------------------------------
    save: (ns, col, id, data, opts) => pick(ns, col).save(ns, col, id, data, opts),
    remove: (ns, col, id) => pick(ns, col).remove(ns, col, id),
  };
};

// ----------------------------------------------------------------------------
// 画面から使うための入口
// db は Firestore の初期化が終わってから決まるので、db ごとに1個だけ作って使い回す。
// ⚠db が変わらない限り同じ窓口を返す(毎回作り直すと useEffect の依存が変わって購読が張り直される)。
// ----------------------------------------------------------------------------
const _byDb = new WeakMap();

export const providerFor = (db, fs, providers = DEFAULT_PROVIDERS) => {
  if (!db) return null;
  const hit = _byDb.get(db);
  if (hit && hit.providers === providers) return hit.provider;
  const provider = createProvider({
    backends: { firebase: createFirebaseBackend(db, fs) },
    providers,
    onUnknownCollection: (ns, col) => {
      // 落とさない。ただし気づけるようにする(移行対象の取りこぼし検知)。
      console.warn(`[data] 地図に無いコレクションです: ${ns}/${col} — src/data/routes.js に追記してください`);
    },
  });
  _byDb.set(db, { providers, provider });
  return provider;
};
