// ============================================================================
// 送る中身の指紋(ハッシュ)
// ----------------------------------------------------------------------------
// なぜ要るか:
//   送信待ちの命令が「もう効いたかどうか」は、書類に押した命令ID(lastCmd)で判断する。
//   だが **命令IDが万が一かぶった時**(端末を開き直した瞬間・IndexedDB を戻した時など)、
//   IDだけを見ると **中身の違う別の保存を「もう効いた」と勘違いして捨ててしまう**。
//   → 中身の指紋も一緒に押し、再送のときは **ID と指紋の両方** が一致した時だけ
//     「もう効いた」と判断する。片方でも違えば、捨てずに知らせて止まる。
//
// ⚠ブラウザでも Node でも同じ値になること。crypto は使わない(同期で必要・環境差を作らない)。
// ⚠キーの順番で値が変わってはいけない。JSON.stringify をそのまま使わない。
// ============================================================================

/** キー順に依存しない文字列にする。⚠配列は並べ替えない(順番が意味を持つため)。 */
export const stableString = (v) => {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return `[${v.map(stableString).join(',')}]`;
  if (typeof v === 'object') {
    if (v.constructor !== Object) {
      // 印(sentinel)やその他の入れ物。中身をそのまま並べる。
      try { return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableString(v[k])}`).join(',')}}`; }
      catch { return String(v); }
    }
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableString(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);   // NaN / Infinity も区別する
  return JSON.stringify(v);
};

/**
 * 64ビットの指紋(FNV-1a)を2本取って128ビット相当にする。
 * ⚠1本だと、現場の量(1日数千件)でも偶然の一致が怖いので2本にする。
 */
const fnv1a = (str, seed) => {
  let h = BigInt(seed);
  const P = 1099511628211n, M = (1n << 64n) - 1n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * P) & M;
  }
  return h.toString(16).padStart(16, '0');
};

/** 送る中身の指紋。同じ中身なら必ず同じ・違えばまず違う。 */
export const payloadHash = (payload) => {
  const s = stableString(payload);
  return `${fnv1a(s, '14695981039346656037')}${fnv1a(s, '1099511628211')}`;
};

/**
 * 命令1件の指紋。**操作の種類も混ぜる**。
 * 混ぜないと「同じ中身の save と setFields」が同じ指紋になり、
 * 意味の違う2つを取り違える(setFields は入れ子を合体しない = 結果が違う)。
 */
export const commandHash = (cmd) => payloadHash({
  op: cmd?.op || 'save',
  ns: cmd?.ns, col: cmd?.col, docId: cmd?.docId,
  patch: cmd?.patch, field: cmd?.field, item: cmd?.item,
  // ⚠baseRev は「いつ送ったか」で変わる値なので指紋に入れない。
  //   入れると、同じ保存を送り直しただけで別物に見えてしまう。
  merge: cmd?.opts?.merge !== false,
});
