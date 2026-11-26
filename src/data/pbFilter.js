// 目的: 「PocketBase の絞り込みの安全な組み立て」 絞り込み(filter)の文字列に値を入れる時に バックスラッシュとダブルクォートを直して、別の記録を取らない・崩れないようにする。
// 入力: 絞り込みの式({:名前} つき)と値の組。
// 出力: 安全に埋め込んだ絞り込みの文字列(pbQuote は値1つ・pbFilter は式全体)。
// 呼ぶ人: src/data/pocketbaseBackend.js・src/data/pbDocStore.js。
// 触る外の物: 無し(純関数・通信しない)。
// 確かめ方: npm test(src/data/__tests__/pbFilter.test.mjs・src の中の手書きの組み立ても探して落とす)。
// ============================================================================
// PocketBase の絞り込み(filter)の文字列を、値を安全に埋め込んで作る(4アプリ共通・同じ中身)
// ----------------------------------------------------------------------------
// 🔒R19(2026-10-31 セキュリティ評価): 以前は値の「"」だけを \" にしていて、「\」をそのままにしていた。
//   PocketBase の絞り込みの文字列の中では「\」も特別な字(次の1字をそのまま扱う印)なので、
//   値に「\」が入ると次のどれかになる(使い捨ての本物 PB 0.40.6 で確かめた・16通り中9通りが違う答え):
//     ・値の最後が「\」 … 閉じの「"」が値の一部と読まれ、文の形が崩れる(400 = その書類が読めない・保存できない)。
//     ・値に「\\」 … 1つの「\」と読まれ、**別の記録(名前が1字違う物)** を取ってくる(読み・上書き・消しの相手の取り違え)。
//     ・値に「\"」 … 形が崩れて 400。
//   (他の記録まで取れてしまう横取りは、今の組み立て方では本物で起こせなかった。それでも直す)
//   ⚠PocketBase の JS SDK の pb.filter() も「'」しか直さない(同じ穴)ので使わない(pbClient.js は SDK を使わない)。
//
// 直し方: 先に「\」を「\\」に、次に「"」を「\"」にする(この順でないと「\"」の「\」が二重に直される)。
//   これで 16通りすべてが「ちょうどその値の1件」を取り、仕掛けの入った値でも他の記録は取れない
//   (C:\Users\anrw3\tmp-onprem-e2e\security\round4\fexpr_records.txt)。
//   改行・'・&&・|| は「"…"」の中では普通の字なので、そのままでよい(同じ所で確かめた)。
//
// ⚠絞り込みに値を入れる所は、**必ず pbFilter / pbQuote を通す**。`ns="${x}"` と手で書かない。
//   (src/data/__tests__/pbFilter.test.mjs が src の中の手書きの組み立てを探して落とす)
// ============================================================================

const BS = '\\';

/** 値1つを、PocketBase の絞り込みの文字列(「"」で囲んだ形)にする。 */
export const pbQuote = (value) => {
  if (value === undefined || value === null) {
    // ⚠「undefined」という名前の記録を探しに行かせない(黙って0件になり、「無い」と誤る)
    throw new TypeError(`pbQuote: 値が ${value} です(絞り込みに入れる値が無い)`);
  }
  if (typeof value === 'object') throw new TypeError('pbQuote: 文字列か数を渡してください');
  return `"${String(value).split(BS).join(BS + BS).split('"').join(BS + '"')}"`;
};

/**
 * 絞り込みの式の {:名前} を、値を pbQuote した物に置き換える。
 *   pbFilter('ns = {:ns} && col = {:col}', { ns, col })
 * ⚠置き換えは1回で行う(値の中に「{:col}」と書いてあっても、もう一度置き換えない)。
 * ⚠式の中に無い名前・値の無い名前は投げる(書き間違いを黙って通さない)。
 */
export const pbFilter = (expr, params = {}) => {
  const used = new Set();
  const out = String(expr).replace(/\{:([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) throw new TypeError(`pbFilter: {:${key}} の値がありません`);
    used.add(key);
    return pbQuote(params[key]);
  });
  const extra = Object.keys(params).filter((k) => !used.has(k));
  if (extra.length) throw new TypeError(`pbFilter: 式で使っていない値があります: ${extra.join(', ')}`);
  return out;
};
