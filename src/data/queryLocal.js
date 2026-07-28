// ============================================================================
// 端末側で行う「絞り込み・並び替え・件数制限」— Firestore と同じ答えを出す
// ----------------------------------------------------------------------------
// なぜ要るか:
//   製品検査・部品検査の画面は、ロットを「新しい順500件」「まだ終わっていない分だけ」
//   のように **絞って** 読んでいる。Firestore はサーバ側で絞ってくれるが、PocketBase の
//   購読はフィルタが効かない(実測 v0.39.9)ので、**端末に全部持ったうえで自分で絞る**。
//
// ⚠⚠ここが本題:「だいたい同じ」では駄目。**Firestore の細かい決まりまで同じ**にする。
//   食い違うと、画面は普通に出るのに件数や中身だけが静かにズレる。いちばん見つけにくい壊れ方。
//
//   Firestore の決まりのうち、直感に反するもの:
//     ① `!=` は **その項目を持っていない書類を返さない**。
//        「completed ではないもの」を頼むと、status が無い書類は落ちる。
//     ② 大小比較(< <= > >=)や in / not-in も同じで、項目が無い書類は落ちる。
//     ③ **並び替えの項目を持っていない書類も落ちる。** createdAt の無い書類は
//        「新しい順500件」に一切出てこない。
//     ④ 不等号を使うと、並び順は **その項目が先頭** になる(指定しなくてもそうなる)。
//     ⑤ 最後に必ず書類ID(__name__)で並ぶ。向きは最後に指定した並び順と同じ。
//     ⑥ 型が違う値どうしも比べられる(null < 真偽 < 数 < 文字 < 配列 < 連想配列)。
//
//   この6つは本物の Firestore と突き合わせて確かめてある:
//     node scripts/verify-query-parity.mjs   (エミュレータと1件ずつ答え合わせ)
//
// ⚠純関数だけを置く。保管庫にも画面にも依存しない(node --test で検査できる)。
// ============================================================================

/** 行の形。Firestore の QueryDocumentSnapshot と同じ呼び方ができる見せかけ。 */
const dataOf = (row) => (typeof row.data === 'function' ? row.data() : row.data) || {};
const idOf = (row) => row.id;

/**
 * 項目を取り出す。ドット区切りは入れ子として読む(Firestore と同じ)。
 * 見つからなければ undefined を返す。**null と undefined は別物**なので潰さない。
 */
export const getField = (data, path) => {
  if (path === '__name__') return undefined;              // 書類IDは別扱い(下で使う)
  const parts = String(path).split('.');
  let cur = data;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
};

/** Firestore の型の順番。小さいほど先。 */
const typeRank = (v) => {
  if (v === null) return 0;
  if (typeof v === 'boolean') return 1;
  if (typeof v === 'number') return 2;
  if (typeof v === 'string') return 4;
  if (Array.isArray(v)) return 6;
  if (typeof v === 'object') return 7;
  return 5;   // 上のどれでもないもの(想定外)は文字と配列の間へ
};

/**
 * Firestore の値の並び順で比べる。a<b なら負、a>b なら正、同じなら 0。
 * ⚠NaN は数の中でいちばん小さい(Firestore の決まり)。
 */
export const compareValues = (a, b) => {
  const ra = typeRank(a), rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0: return 0;                                        // null どうし
    case 1: return a === b ? 0 : (a ? 1 : -1);               // false < true
    case 2: {
      const na = Number.isNaN(a), nb = Number.isNaN(b);
      if (na && nb) return 0;
      if (na) return -1;
      if (nb) return 1;
      return a === b ? 0 : (a < b ? -1 : 1);
    }
    case 4: return a === b ? 0 : (a < b ? -1 : 1);           // 文字は符号位置の順
    case 6: {                                                // 配列は前から1つずつ
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) { const c = compareValues(a[i], b[i]); if (c) return c; }
      return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
    }
    case 7: {                                                // 連想配列はキー名→値の順
      const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
      const n = Math.min(ka.length, kb.length);
      for (let i = 0; i < n; i++) {
        if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
        const c = compareValues(a[ka[i]], b[kb[i]]); if (c) return c;
      }
      return ka.length === kb.length ? 0 : (ka.length < kb.length ? -1 : 1);
    }
    default: return 0;
  }
};

export const valuesEqual = (a, b) => compareValues(a, b) === 0 && typeRank(a) === typeRank(b);

/** 不等号(この演算子を使うと、並び順にその項目が入る) */
const INEQUALITY = new Set(['!=', '<', '<=', '>', '>=', 'not-in']);

// ⚠⚠ここから下の2つの決まりは、本物の Firestore と突き合わせて **間違いを見つけて直した** もの。
//   最初は素直に書いていたが、エミュレータと答えが合わず4件ズレた(2026-07-28)。
//   思い込みで書くと、画面は普通に見えるのに一覧の中身だけが静かに変わる。
//
//   ① `!=` と `not-in` は **null の書類も返さない**。
//      「completed ではないもの」に、status が null の書類は入らない。
//   ② 大小比較(< <= > >=)は **同じ型どうしでしか比べない**。
//      createdAt >= 200 に、createdAt が文字の "100" や null の書類は入らない
//      (型の順番では文字は数より後ろなので、素直に比べると入ってしまう)。
const sameType = (a, b) => typeRank(a) === typeRank(b);
const OPS = {
  '==': (v, t) => valuesEqual(v, t),
  '!=': (v, t) => v !== null && !valuesEqual(v, t),                 // ⚠null は返らない
  '<': (v, t) => sameType(v, t) && compareValues(v, t) < 0,         // ⚠同じ型どうしだけ
  '<=': (v, t) => sameType(v, t) && compareValues(v, t) <= 0,
  '>': (v, t) => sameType(v, t) && compareValues(v, t) > 0,
  '>=': (v, t) => sameType(v, t) && compareValues(v, t) >= 0,
  in: (v, t) => Array.isArray(t) && t.some((x) => valuesEqual(v, x)),
  'not-in': (v, t) => v !== null && Array.isArray(t) && !t.some((x) => valuesEqual(v, x)),  // ⚠null は返らない
  'array-contains': (v, t) => Array.isArray(v) && v.some((x) => valuesEqual(x, t)),
  'array-contains-any': (v, t) => Array.isArray(v) && Array.isArray(t) && v.some((x) => t.some((y) => valuesEqual(x, y))),
};

/** 1つの条件に合うか。⚠**項目が無い書類は、どの演算子でも合わない**(Firestore と同じ)。 */
export const matchesCondition = (data, cond) => {
  if (!Array.isArray(cond) || cond.length !== 3) {
    throw new Error(`queryLocal: 条件は [項目, 演算子, 値] の3つ組で渡してください: ${JSON.stringify(cond)}`);
  }
  const [field, op, target] = cond;
  const fn = OPS[op];
  // ⚠知らない演算子を「合う」でも「合わない」でも扱わない。**黙って違う一覧を作らない。**
  if (!fn) throw new Error(`queryLocal: 演算子「${op}」にはまだ対応していません (${field})。実装してから使ってください。`);
  const v = getField(data, field);
  if (v === undefined) return false;
  return fn(v, target);
};

/**
 * 実際に使う並び順を組み立てる(Firestore の決まりどおり)。
 *   ・不等号を使っていて並び順の指定が無ければ、その項目の昇順が先頭に入る
 *   ・最後に必ず書類ID。向きは最後に指定した並び順と同じ
 */
export const effectiveOrder = (spec = {}) => {
  const ord = (spec.orderBy || []).map((o) => (Array.isArray(o) ? [o[0], o[1] || 'asc'] : [o, 'asc']));
  const ineq = (spec.where || []).find((w) => Array.isArray(w) && INEQUALITY.has(w[1]));
  if (ineq && !ord.length) ord.push([ineq[0], 'asc']);
  const lastDir = ord.length ? ord[ord.length - 1][1] : 'asc';
  return [...ord, ['__name__', lastDir]];
};

/** 並び順の基準で1件を比べるための値。書類IDだけ特別扱い。 */
const orderKey = (row, field) => (field === '__name__' ? idOf(row) : getField(dataOf(row), field));

const compareRows = (order) => (ra, rb) => {
  for (const [field, dir] of order) {
    const c = compareValues(orderKey(ra, field), orderKey(rb, field));
    if (c) return dir === 'desc' ? -c : c;
  }
  return 0;
};

/**
 * 絞り込み・並び替え・件数制限をまとめて行う。
 * @param rows [{id, data}] または [{id, data(){}}]
 * @param spec { where, orderBy, limit, after }
 *   after は getPage が返した「続きの位置」({id, data})。
 * @returns 絞り込み後の行(元の配列は変えない)
 */
export const applyQuery = (rows, spec = {}) => {
  const order = effectiveOrder(spec);
  let out = rows.filter((r) => {
    const d = dataOf(r);
    for (const c of (spec.where || [])) if (!matchesCondition(d, c)) return false;
    // ⚠並び替えの項目を持っていない書類は、Firestore では **返ってこない**。
    //   ここを忘れると「エミュレータでは出ないのに本番では出る」が起きる。
    for (const [field] of order) {
      if (field === '__name__') continue;
      if (getField(d, field) === undefined) return false;
    }
    return true;
  });
  out.sort(compareRows(order));
  if (spec.after) {
    const cmp = compareRows(order);
    const idx = out.findIndex((r) => cmp(r, spec.after) > 0);
    out = idx < 0 ? [] : out.slice(idx);
  }
  if (spec.limit !== undefined && spec.limit !== null) out = out.slice(0, Math.max(0, Number(spec.limit) || 0));
  return out;
};
