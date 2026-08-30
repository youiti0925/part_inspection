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

/**
 * REST の返事(1件)を、画面が使う素の行に戻す。
 * ⚠REST は値を { stringValue: 'x' } のような包みで返す。ほどくのは **ここ1か所だけ**。
 *   画面ごとにほどくと、数値と文字が混ざって数字が狂う(そして誰も気づかない)。
 * ⚠数(integerValue)は文字で返ってくるので **必ず数に戻す**。
 *   戻さないと合計が文字の連結になり、容量の数字が化ける。
 */
export const decodeRestValue = (v) => {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(decodeRestValue);
  if ('mapValue' in v) {
    const out = {};
    for (const [k, x] of Object.entries((v.mapValue && v.mapValue.fields) || {})) out[k] = decodeRestValue(x);
    return out;
  }
  return null;
};

/** REST の書類 → { id, …選んだ項目 }。⚠id は書類の名前の最後の区切りから採る。 */
export const decodeRestDoc = (doc) => {
  const out = {};
  for (const [k, v] of Object.entries((doc && doc.fields) || {})) out[k] = decodeRestValue(v);
  const name = String((doc && doc.name) || '');
  return { id: name.slice(name.lastIndexOf('/') + 1), ...out };
};

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
 *   使わないアプリは fs に query 系を渡さなくても今までどおり動く(必要な時だけ要求する)。
 *
 * ⚠⚠ このファイルは 2026-07-27 時点で **4アプリすべて同一**。
 *   片方だけ直すと、次に配った時に静かに巻き戻る。直したら4つ全部へ配ること。
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
  const hasFilter = (o) => !!(o && (o.where || o.orderBy || o.limit !== undefined || o.after));
  /** 絞り込みがあれば Query を、無ければ CollectionReference をそのまま返す。 */
  const queryRef = (ns, col, opts = {}) => {
    const base = colRef(ns, col);
    if (!hasFilter(opts)) return base;
    const parts = [];
    // ⚠順番を勝手に入れ替えない。where → orderBy → startAfter → limit は今までの手書きと同じ並び。
    //   startAfter は orderBy の後ろ(並べ替えの基準が無いと「続きの位置」が決まらない)。
    for (const w of (opts.where || [])) parts.push(needLazy('where', '絞り込み(where)')(...w));
    for (const o of (opts.orderBy || [])) parts.push(needLazy('orderBy', '並び順(orderBy)')(...(Array.isArray(o) ? o : [o])));
    if (opts.after) parts.push(needLazy('startAfter', '続きから読む(after)')(opts.after));
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

    // --- 絞り込み付きの読み ---------------------------------------------------
    // ⚠絞り込みの指定は「ただのデータ」で受け取る({where, orderBy, limit, after})。
    //   画面が Firestore の query()/where() を組み立てると、それは Firebase 固有の値なので
    //   窓口の外へ出てしまい、保管庫を差し替えられなくなる。
    watchQuery: (ns, col, spec = {}, cb, opts = {}) =>
      listen(queryRef(ns, col, { ...opts, ...spec }), (snap) => cb(snap.docs.map(opts.map || ROW_DOCID_WINS), snap), opts.onError,
        opts.includeMetadataChanges ? { includeMetadataChanges: true } : null),
    /** 1ページ分。戻りの cursor を次の spec.after に渡すと続きが取れる。 */
    getPage: async (ns, col, spec = {}, opts = {}) => {
      const snap = await fs.getDocs(queryRef(ns, col, { ...opts, ...spec }));
      return { rows: snap.docs.map(opts.map || ROW_DOCID_WINS), cursor: snap.docs.length ? snap.docs[snap.docs.length - 1] : null };
    },

    // ========================================================================
    // 📉 項目を選んで読む（重い項目を運ばない）
    // ------------------------------------------------------------------------
    // 🚨🚨 これで減るのは **通信量と待ち時間だけ**。読み取り件数(＝無料枠の課金)は
    //   1件も減りません。Firestore は「書類を何件読んだか」で数えるからです。
    //   実測(2026-08-30・写真2,355件): 全部読み 100.0MB/6.9秒 → 項目を選ぶ読み 1.185MB/0.9秒。
    //   現場の携帯の通信量に効きます。枠の話と混ぜないでください。
    //
    // ⚠⚠ ブラウザ向けの Firestore SDK には「取る項目を選ぶ」機能が **1つもありません**
    //   (実測: firebase/firestore の export 119個に select / mask に当たる物が無い)。
    //   REST の runQuery には有るので、**窓口の中でだけ** REST を使います。
    //   画面は今までどおり窓口しか呼びません(保管庫を差し替えられる形を壊さない)。
    //
    // ⚠使えない時(合言葉が取れない・網が繋がらない等)は **今までどおり全件読みへ落ちます**。
    //   🚨落ちた事は必ず戻り値で言います(projected:false と fellBack)。**黙って落ちません。**
    //
    // @param fields    取る項目の名前。例 ['lotId','kind','at','bytes']
    // @param opts.getToken  async ()=>string  ログインの合言葉を返す係(画面が渡す)
    // @param opts.where     絞り込み(getPage と同じ形)
    // @returns { rows, projected, fellBack }
    // ========================================================================
    getPageFields: async (ns, col, fields = [], opts = {}) => {
      const full = async (why) => {
        const rows = await fs.getDocs(queryRef(ns, col, { where: opts.where }));
        return { rows: rows.docs.map(ROW_DOCID_WINS), projected: false, fellBack: why };
      };
      if (!Array.isArray(fields) || fields.length === 0) return full('取る項目が指定されていません');
      if (typeof fetch !== 'function') return full('この端末に fetch がありません');
      if (typeof opts.getToken !== 'function') return full('ログインの合言葉を渡す係(getToken)がありません');
      const projectId = db && db.app && db.app.options && db.app.options.projectId;
      if (!projectId) return full('プロジェクトIDが読めません');
      const st = (db && db._settings) || {};
      const host = st.host || 'firestore.googleapis.com';
      const scheme = st.ssl === false ? 'http' : 'https';
      let token;
      try { token = await opts.getToken(); } catch (e) { return full(`合言葉が取れません: ${e && e.message}`); }
      if (!token) return full('合言葉が空です');
      const segs = dataPath(ns, col);                     // artifacts/{ns}/public/data/{col}
      const parent = `projects/${projectId}/databases/(default)/documents/${segs.slice(0, -1).join('/')}`;
      const q = { structuredQuery: { from: [{ collectionId: segs[segs.length - 1] }],
        select: { fields: fields.map((f) => ({ fieldPath: f })) } } };
      // ⚠絞り込みの形は getPage と同じ配列。ここで Firestore 固有の値は作らない。
      const w = (opts.where || []).map(([f, op, v]) => ({ fieldFilter: { field: { fieldPath: f },
        op: ({ '==': 'EQUAL', '!=': 'NOT_EQUAL', '>=': 'GREATER_THAN_OR_EQUAL', '<=': 'LESS_THAN_OR_EQUAL',
          '>': 'GREATER_THAN', '<': 'LESS_THAN' })[op],
        value: typeof v === 'number' ? { integerValue: String(v) } : { stringValue: String(v) } } }));
      if (w.length === 1) q.structuredQuery.where = w[0];
      else if (w.length > 1) q.structuredQuery.where = { compositeFilter: { op: 'AND', filters: w } };
      let res;
      try {
        res = await fetch(`${scheme}://${host}/v1/${parent}:runQuery`, { method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(q) });
      } catch (e) { return full(`通信に失敗しました: ${e && e.message}`); }
      if (!res.ok) return full(`サーバが断りました(${res.status})`);
      let body;
      try { body = await res.json(); } catch (e) { return full(`返事が読めません: ${e && e.message}`); }
      if (!Array.isArray(body)) return full('返事の形が違います');
      return { rows: body.filter((x) => x && x.document).map((x) => decodeRestDoc(x.document)), projected: true, fellBack: '' };
    },

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
    // 絞り込み付きの読み(製品検査・部品検査が使う)。保管庫が違っても同じ答えを返す。
    watchQuery: call('watchQuery'),
    getPage: callAsync('getPage'),
    // 📉項目を選んで読む(重い項目を運ばない)。⚠読み取り件数は減らない。減るのは通信量と待ち時間。
    getPageFields: callAsync('getPageFields'),

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

/**
 * PocketBase の保管庫を足すための差し込み口。
 * ⚠ここで直接 import しない。PocketBase を使わないアプリのビルドに
 *   余計なコードを載せないため、使う側が registerPocketbaseFactory() で入れる。
 */
let _pbFactory = null;
export const registerPocketbaseFactory = (fn) => { _pbFactory = fn; };

/**
 * @param pbConfig  { url, email, password } があれば PocketBase の保管庫も作る。
 *   ⚠管理者(superuser)の資格情報を渡さないこと。端末用の普通のアカウントを使う。
 * ⚠providers を変えない限り、保管庫は Firebase のまま = 表示も保存先も1バイトも変わらない。
 */
export const providerFor = (db, fs, providers = DEFAULT_PROVIDERS, pbConfig = null) => {
  if (!db) return null;
  const key = pbConfig?.url || '';
  const hit = _byDb.get(db);
  if (hit && hit.providers === providers && hit.pbUrl === key) return hit.provider;

  const backends = { firebase: createFirebaseBackend(db, fs) };
  // PocketBase を使う設定になっている時だけ作る。
  const usesPb = Object.values(providers).includes('pocketbase');
  if (usesPb) {
    if (!_pbFactory) throw new Error('PocketBase の保管庫が登録されていません(registerPocketbaseFactory を先に呼んでください)');
    if (!pbConfig?.url) throw new Error('PocketBase の接続先が設定されていません(設定の pocketbase を確認してください)');
    backends.pocketbase = _pbFactory(pbConfig);
  }

  const provider = createProvider({
    backends,
    providers,
    onUnknownCollection: (ns, col) => {
      // 落とさない。ただし気づけるようにする(移行対象の取りこぼし検知)。
      console.warn(`[data] 地図に無いコレクションです: ${ns}/${col} — src/data/routes.js に追記してください`);
    },
  });
  _byDb.set(db, { providers, pbUrl: key, provider });
  return provider;
};

export { DATA_DELETE, DATA_SERVER_NOW };
