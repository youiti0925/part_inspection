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
//
// ⚠⚠ **Firebase 固有のオブジェクトを窓口の外へ出さない/入れない。**
//   deleteField() や serverTimestamp() を画面が持っていると保管庫を差し替えられない。
//   画面は src/data/sentinels.js の DATA_DELETE / DATA_SERVER_NOW を使い、
//   Firestore 固有の値への変換はここで1回だけ行う。
//   同じ理由で **docRef() を一般公開の逃げ道として残さない**。
//   「読んで→書く」が要る場面は、意図の名前を付けた操作(claimOnce / appendCapped /
//   setFields)として窓口に置く。PocketBase では作り方が全く違うため、
//   「Firestoreの参照をください」という形のままでは移行できない。
// ============================================================================

import { dataPath, backendFor, DEFAULT_PROVIDERS, areaOf, isKnownCollection } from './routes.js';
import { materialize, withDeletions, DATA_DELETE, DATA_SERVER_NOW } from './sentinels.js';

// ----------------------------------------------------------------------------
// 1件を JS のオブジェクトに直す方法は **2通りある**。混ぜてはいけない。
// ⚠製品検査は本文の中にも `id` を書いている(App.jsx の保存で `{ ...rest, id }`)。
//   そのため「ドキュメントIDを優先」と「本文のidを優先」で結果が変わる。
//   既存の呼び出し元がどちらだったかを、そのまま引き継ぐこと。
// ----------------------------------------------------------------------------
export const ROW_DOCID_WINS = (d) => ({ ...d.data(), id: d.id }); // 既存: {...d.data(), id: d.id}
export const ROW_DATA_WINS = (d) => ({ id: d.id, ...d.data() });  // 既存: {id: d.id, ...d.data()}

/** 権利取りの結果。⚠通信失敗・認証失敗・サーバーエラーを「取れなかった」と同一に扱わない。 */
export const CLAIM = Object.freeze({
  OK: 'ok',           // 取れた
  TAKEN: 'taken',     // 他の端末が先に取った(期待した状態ではなかった)
  MISSING: 'missing', // 対象が存在しない
  ERROR: 'error',     // 通信/認証/サーバーの失敗 ← 「取れなかった」ではない
});

/**
 * Firebase 版の保管庫。
 * @param db  Firestore インスタンス
 * @param fs  { collection, doc, onSnapshot, setDoc, deleteDoc, getDocs, getDoc,
 *              serverTimestamp, deleteField, updateDoc, runTransaction }
 *            絞り込みを使うアプリはさらに { query, where, orderBy, limit }。
 *
 * ⚠絞り込み(where/orderBy/limit)は **部品検査で先に必要になった** 部分。
 *   最終検査は1件も使っていないので、あちらの provider.js にはまだ無い。
 *   ファイルを4リポジトリで同一に保つため、次に触るときこの版を配ること。
 *   使わないアプリは fs に query 系を渡さなくても今までどおり動く(必要な時だけ要求する)。
 */
export const createFirebaseBackend = (db, fs) => {
  const need = (n) => { if (typeof fs?.[n] !== 'function') throw new Error(`createFirebaseBackend: fs.${n} が渡されていません`); };
  ['collection', 'doc', 'onSnapshot', 'setDoc', 'deleteDoc', 'getDocs', 'getDoc',
    'serverTimestamp', 'deleteField', 'updateDoc', 'runTransaction'].forEach(need);

  const colRef = (ns, col) => fs.collection(db, ...dataPath(ns, col));
  const docRef = (ns, col, id) => fs.doc(db, ...dataPath(ns, col, id));

  /** 印 → Firestore 固有の値。ここが唯一の変換地点。 */
  const CONV = { delete: () => fs.deleteField(), serverNow: () => fs.serverTimestamp() };
  /** 画面から来た生データ → Firestore へ渡せる形。__deleteMapKeys もここで解く。 */
  const prep = (raw) => materialize(withDeletions(raw), CONV);

  // --- 絞り込み(並び順・件数・条件) -----------------------------------------
  // ⚠Firestore の orderBy()/limit()/where() を画面が組み立てると、それは
  //   **Firebase 固有のオブジェクト**なので窓口の外へ出てしまう(deleteField と同じ問題)。
  //   PocketBase は文字列のフィルタ式で、形が全く違う。
  //   → 画面は「何で並べる・何件・どの条件」だけを **ただの配列** で渡す。
  //     Firestore 固有の値への変換はここで1回だけ行う。
  //       { orderBy: [['createdAt','desc']], limit: 500, where: [['type','==','done']] }
  //
  // ⚠この3つの fs は「絞り込みを使うときだけ」必要。使わないアプリ(最終検査)は
  //   今までどおり渡さなくてよい。渡し忘れたら、その場で名指しで落ちる。
  const needLazy = (n, why) => {
    if (typeof fs?.[n] !== 'function') throw new Error(`createFirebaseBackend: ${why} には fs.${n} が要ります(FS_API に足してください)`);
    return fs[n];
  };
  const hasFilter = (o) => !!(o && (o.where || o.orderBy || o.limit !== undefined));
  /** 絞り込みがあれば Query を、無ければ CollectionReference をそのまま返す。 */
  const queryRef = (ns, col, opts = {}) => {
    const base = colRef(ns, col);
    if (!hasFilter(opts)) return base;
    const parts = [];
    // ⚠順番を勝手に入れ替えない。where → orderBy → limit は今までの手書きと同じ並び。
    for (const w of (opts.where || [])) parts.push(needLazy('where', '絞り込み(where)')(...w));
    for (const o of (opts.orderBy || [])) parts.push(needLazy('orderBy', '並び順(orderBy)')(...(Array.isArray(o) ? o : [o])));
    if (opts.limit !== undefined) parts.push(needLazy('limit', '件数制限(limit)')(opts.limit));
    return needLazy('query', '絞り込み')(base, ...parts);
  };

  // ⚠エラー用の関数は「渡された時だけ」渡す。空の関数を勝手に足すと、
  //   今まで console に出ていた購読エラーが黙って消える。
  // ⚠includeMetadataChanges も「渡された時だけ」。Firestore は第2引数の有無で
  //   引数の意味が変わる(onSnapshot(ref, options, next, onError))ので、
  //   既定で {} を入れると今までと呼び方が変わってしまう。
  const listen = (ref, next, onErr, snapOpts) => {
    if (snapOpts) return onErr ? fs.onSnapshot(ref, snapOpts, next, onErr) : fs.onSnapshot(ref, snapOpts, next);
    return onErr ? fs.onSnapshot(ref, next, onErr) : fs.onSnapshot(ref, next);
  };

  return {
    kind: 'firebase',
    raw: db,
    _colRef: colRef,
    _docRef: docRef,

    watchCollection: (ns, col, cb, opts = {}) =>
      listen(queryRef(ns, col, opts), (snap) => cb(snap.docs.map(opts.map || ROW_DOCID_WINS), snap), opts.onError,
        opts.includeMetadataChanges ? { includeMetadataChanges: true } : null),
    watchDoc: (ns, col, id, cb, opts = {}) =>
      listen(docRef(ns, col, id), (snap) => cb(snap.exists() ? snap.data() : null, snap), opts.onError,
        opts.includeMetadataChanges ? { includeMetadataChanges: true } : null),
    getAll: async (ns, col, opts = {}) => (await fs.getDocs(queryRef(ns, col, opts))).docs.map(opts.map || ROW_DOCID_WINS),
    getOne: async (ns, col, id) => { const s = await fs.getDoc(docRef(ns, col, id)); return s.exists() ? s.data() : null; },

    save: (ns, col, id, data, opts = {}) => fs.setDoc(docRef(ns, col, id), prep(data), { merge: opts.merge !== false }),
    remove: (ns, col, id) => fs.deleteDoc(docRef(ns, col, id)),

    // --- 指定した項目だけを丸ごと差し替える -----------------------------------
    // ⚠merge:true は入れ子のmapを再帰マージするので「キーを消す」が伝わらない。
    //   抜取/スキップ設定の許可OFF・ロック解除・条件クリアはこれで復活していた(監査確定)。
    //   Firestore では updateDoc がmapフィールドを丸ごと置換する。
    setFields: (ns, col, id, fields) => fs.updateDoc(docRef(ns, col, id), prep(fields)),

    // --- 割り込まれない書き込み -----------------------------------------------
    /** 期待した状態のままなら patch を書く。1台だけが権利を取る。 */
    claimOnce: async (ns, col, id, expect, patch) => {
      const ref = docRef(ns, col, id);
      try {
        return await fs.runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) return { acquired: false, reason: CLAIM.MISSING };
          const cur = snap.data() || {};
          for (const [k, v] of Object.entries(expect || {})) {
            // ⚠数で期待する項目は欠落を0とみなす。null期待は「まだ無い」の意味。
            //   0 を null に潰すと reminds:0 が実在した時に永久に送れなくなる。
            const got = typeof v === 'number' ? (Number(cur[k]) || 0) : (cur[k] ?? null);
            if (got !== v) return { acquired: false, reason: CLAIM.TAKEN };
          }
          tx.set(ref, prep({ ...patch, updatedAt: DATA_SERVER_NOW }), { merge: true });
          return { acquired: true, reason: CLAIM.OK };
        });
      } catch (e) {
        // ⚠ここを acquired:false と同一に扱わない。通信が切れただけかもしれない。
        return { acquired: false, reason: CLAIM.ERROR, error: e };
      }
    },

    /** 配列の項目を足す。合計が maxBytes を超えたら古い方から落とす。
     *  ⚠2台で同時に足すと「読んで→足して→丸ごと書き戻す」では後から書いた側が
     *    相手の1件を消す。書く直前に読み直して足す。 */
    appendCapped: async (ns, col, id, field, item, opts = {}) => {
      const ref = docRef(ns, col, id);
      const max = Number(opts.maxBytes) || 900 * 1024;
      const fallback = opts.fallback || {};
      return await fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        const cur = snap.exists() ? (snap.data() || {}) : fallback;
        let arr = [...((cur && cur[field]) || []), item];
        const size = () => JSON.stringify(arr).length;
        let dropped = 0;
        while (arr.length > 1 && size() > max) { arr = arr.slice(1); dropped++; }
        // ⚠消えていた場合は中身ごと作り直す。field だけ書くと名前なしの幽霊になる。
        if (!snap.exists()) tx.set(ref, prep({ ...fallback, [field]: arr, updatedAt: DATA_SERVER_NOW }));
        else tx.set(ref, prep({ [field]: arr, updatedAt: DATA_SERVER_NOW }), { merge: true });
        return { count: arr.length, dropped };
      });
    },
  };
};

/**
 * 窓口。機能領域ごとに保管庫へ振り分ける。
 * @param backends  { firebase: <createFirebaseBackend の戻り>, pocketbase?: ... }
 * @param providers { inspection:'firebase', contact:'firebase', ... }
 */
export const createProvider = ({ backends, providers = DEFAULT_PROVIDERS, onUnknownCollection } = {}) => {
  if (!backends || typeof backends !== 'object') throw new Error('createProvider: backends が必要です');

  // --- 実行時のルート監査 ---------------------------------------------------
  // ⚠コレクション名は変数でも渡る(`watch(colName, cb)`)。ソースを読むだけでは
  //   「全部の置き場所を洗い出した」と言えない。実際に窓口を通った (名前空間, コレクション)
  //   をここで記録し、画面を一通り触った後に地図と突き合わせる。
  const audit = new Map(); // "ns/col" -> { ns, col, area, backend, known, ops:{}, count }
  const record = (ns, col, op) => {
    const key = `${ns}/${col}`;
    let e = audit.get(key);
    if (!e) {
      e = { ns, col, area: areaOf(ns, col), backend: backendFor(ns, col, providers), known: isKnownCollection(ns, col), ops: {}, count: 0 };
      audit.set(key, e);
    }
    e.ops[op] = (e.ops[op] || 0) + 1;
    e.count++;
    return e;
  };

  const pick = (ns, col) => {
    if (onUnknownCollection && !isKnownCollection(ns, col)) onUnknownCollection(ns, col);
    const name = backendFor(ns, col, providers);
    const b = backends[name];
    if (!b) {
      throw new Error(
        `保管庫「${name}」がまだ用意されていません (${ns}/${col} = ${areaOf(ns, col)})。`
      );
    }
    return b;
  };
  const dispatch = (fn, ns, col, rest) => {
    record(ns, col, fn);
    const b = pick(ns, col);
    if (typeof b[fn] !== 'function') throw new Error(`保管庫「${b.kind}」は ${fn} に対応していません (${ns}/${col})`);
    return b[fn](ns, col, ...rest);
  };
  /** 購読だけは同期(解除用の関数をその場で返す必要がある)。 */
  const call = (fn) => (ns, col, ...rest) => dispatch(fn, ns, col, rest);
  /** 読み書きは必ず Promise を返す。
   *  ⚠同期で throw すると `save(...).catch(...)` で拾えず、保存の失敗が黙って消える。 */
  const callAsync = (fn) => async (ns, col, ...rest) => dispatch(fn, ns, col, rest);

  return {
    providers,
    backends,
    /** その置き場所がどの機能領域・どの保管庫か(移行の進み具合を数えるのに使う)。 */
    routeOf: (ns, col) => ({ area: areaOf(ns, col), backend: backendFor(ns, col, providers), known: isKnownCollection(ns, col) }),
    /** その保管庫の能力表(呼び出し側が「できるか」を見るため)。 */
    capabilitiesOf: (ns, col) => pick(ns, col).capabilities || null,
    /** 実際に窓口を通った置き場所の一覧(実行時のルート監査)。 */
    routeAudit: () => [...audit.values()].sort((a, b) => (a.ns + a.col).localeCompare(b.ns + b.col)),
    resetRouteAudit: () => audit.clear(),

    // --- 読む ---------------------------------------------------------------
    watchCollection: call('watchCollection'),
    watchDoc: call('watchDoc'),
    getAll: callAsync('getAll'),
    getOne: callAsync('getOne'),

    // --- 書く ---------------------------------------------------------------
    save: callAsync('save'),
    remove: callAsync('remove'),
    setFields: callAsync('setFields'),

    // --- 割り込まれない書き込み(意図の名前で呼ぶ) ----------------------------
    claimOnce: callAsync('claimOnce'),
    appendCapped: callAsync('appendCapped'),
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

export { DATA_DELETE, DATA_SERVER_NOW };
