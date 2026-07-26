// ============================================================================
// 保管庫の「できること表」(能力表)
// ----------------------------------------------------------------------------
// なぜ要るか: Firebase と PocketBase は同じではない。
// 一番大きい違いは **オフライン書き込み**。
//   Firestore は persistentLocalCache を有効にしてあるので、電波が切れても
//   保存が端末に貯まり、つながった時に自動で送られる。現場の Wi-Fi は切れる。
//   PocketBase にはこの仕組みが無い → 自前で作らないと「保存したのに消える」。
//
// ⚠実測していない項目は null(UNVERIFIED)。**推測で true/false を書かない。**
//   null は「使えない」でも「使える」でもない。can() は安全側(false)に倒すが、
//   報告では「未実測」と書くこと。
// ============================================================================

export const CAPABILITY_KEYS = Object.freeze([
  'realtime',        // 変更が自動で流れてくる(購読)
  'offlineWrites',   // 電波が切れている間の保存を貯めて後で送る
  'atomicWrite',     // 「読んで→書く」を割り込まれずに行える
  'fileStorage',     // ファイルを本体と別に置ける
  'serverTimestamp', // サーバ側の時刻を入れられる
  'mapKeyDelete',    // 入れ子のキーを1個だけ消せる
  'nestedArrays',    // 配列の中に配列を入れられる
  'docSizeLimit',    // 1件の最大バイト数
]);

/** 未実測。⚠推測で埋めない。 */
export const UNVERIFIED = null;

/** さらに細かい「割り込まれない書き込み」の中身(M2で1つずつ実測する)。 */
export const ATOMIC_PRIMITIVE_KEYS = Object.freeze([
  'claimOnce',             // 同じ権利を1台だけが取れる
  'compareAndSet',         // 期待した値のままなら書く
  'increment',             // 数を1つ増やす(取りこぼさない)
  'multiRecordTransaction' // 複数レコードをまとめて成功/失敗させる
]);

const frozenAtomic = (o) => Object.freeze({
  claimOnce: UNVERIFIED, compareAndSet: UNVERIFIED, increment: UNVERIFIED, multiRecordTransaction: UNVERIFIED, ...o,
});

// ----------------------------------------------------------------------------
// Firebase(現行) — 実測済み。根拠は本番コードと監査。
// ----------------------------------------------------------------------------
export const FIREBASE_CAPABILITIES = Object.freeze({
  provider: 'firebase',
  realtime: true,
  offlineWrites: true,   // src/App.firebase.jsx の initializeFirestore(persistentLocalCache)
  atomicWrite: true,     // runTransaction
  fileStorage: true,     // Storage はあるが実データは0件。中身は Firestore 内の base64
  serverTimestamp: true,
  mapKeyDelete: true,    // deleteField()
  nestedArrays: false,   // ⚠配列の中の配列を保存できない(自動回転が本番で1度も保存できていなかった)
  docSizeLimit: 1_048_576,
  atomicPrimitives: frozenAtomic({
    claimOnce: UNVERIFIED, compareAndSet: UNVERIFIED, increment: UNVERIFIED, multiRecordTransaction: UNVERIFIED,
  }),
});

// ----------------------------------------------------------------------------
// PocketBase — 実測できたものだけ true/false。
// ⚠この表を手で書き換えないこと。M2 の適合試験(conformance)が実測して
//   evidence ファイルを吐き、それを読み込んで上書きする。
// ----------------------------------------------------------------------------
export const POCKETBASE_CAPABILITIES = Object.freeze({
  provider: 'pocketbase',
  realtime: true,          // SSE 購読
  offlineWrites: false,    // ⚠無い。M2 で送信待ち箱(outbox)を自前で作る
  atomicWrite: UNVERIFIED, // ← claimOnce の実測で決める
  fileStorage: true,
  serverTimestamp: true,   // created/updated は サーバ側で入る
  mapKeyDelete: false,     // ⚠JSON 列を丸ごと書き直す。消す場所は自分で計算する必要がある
  nestedArrays: true,
  docSizeLimit: UNVERIFIED,
  atomicPrimitives: frozenAtomic({}),
});

/** まだ実測していない項目の一覧。報告に必ず載せる。 */
export const unverifiedCapabilities = (caps) => {
  if (!caps) return [...CAPABILITY_KEYS];
  const out = CAPABILITY_KEYS.filter((k) => caps[k] === UNVERIFIED);
  const ap = caps.atomicPrimitives || {};
  ATOMIC_PRIMITIVE_KEYS.forEach((k) => { if (ap[k] === UNVERIFIED) out.push(`atomicPrimitives.${k}`); });
  return out;
};

/**
 * その保管庫でその機能が使えるか。
 * ⚠未実測(null)は false 側に倒す。「たぶん使える」で進めない。
 *   ただし「使えないと確定した」わけではないので、報告では unverifiedCapabilities() を見る。
 */
export const can = (caps, key) => {
  if (!caps) return false;
  const v = key.startsWith('atomicPrimitives.')
    ? (caps.atomicPrimitives || {})[key.slice('atomicPrimitives.'.length)]
    : caps[key];
  return v === true;
};

/** 1件の上限バイト数。未実測なら null。 */
export const docLimitOf = (caps) => (caps && typeof caps.docSizeLimit === 'number' ? caps.docSizeLimit : null);

/**
 * 移行しても大丈夫かの判定材料。
 * 「移行先に無い能力」を並べて返す。空でなければ、その分を自前で作るか、移行しない。
 */
export const capabilityGaps = (from, to) => {
  const gaps = [];
  for (const k of CAPABILITY_KEYS) {
    if (k === 'docSizeLimit' || k === 'nestedArrays') continue; // 大小の比較は別扱い
    if (from[k] === true && to[k] !== true) {
      gaps.push({ key: k, from: from[k], to: to[k], measured: to[k] !== UNVERIFIED });
    }
  }
  const fl = docLimitOf(from); const tl = docLimitOf(to);
  if (fl !== null && tl !== null && tl < fl) gaps.push({ key: 'docSizeLimit', from: fl, to: tl, measured: true });
  return gaps;
};

/** 実測結果(evidence)を能力表へ取り込む。実測値だけを反映する。 */
export const applyEvidence = (base, evidence) => {
  if (!evidence || typeof evidence !== 'object') return base;
  const out = { ...base, atomicPrimitives: { ...(base.atomicPrimitives || {}) } };
  for (const k of CAPABILITY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(evidence, k) && evidence[k] !== undefined) out[k] = evidence[k];
  }
  const ap = evidence.atomicPrimitives || {};
  for (const k of ATOMIC_PRIMITIVE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(ap, k) && ap[k] !== undefined) out.atomicPrimitives[k] = ap[k];
  }
  // atomicWrite は claimOnce と compareAndSet の両方が実測 true の時だけ true。
  const a = out.atomicPrimitives;
  if (a.claimOnce === true && a.compareAndSet === true) out.atomicWrite = true;
  else if (a.claimOnce === false || a.compareAndSet === false) out.atomicWrite = false;
  return Object.freeze({ ...out, atomicPrimitives: Object.freeze(a) });
};

export const CAPABILITIES = Object.freeze({
  firebase: FIREBASE_CAPABILITIES,
  pocketbase: POCKETBASE_CAPABILITIES,
});
