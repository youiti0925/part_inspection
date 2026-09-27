// =============================================================================
//  src/opsim/subLabel.js — 札の「型式｜添え書き」の畳み方(純関数。画面の部品ではない)
// -----------------------------------------------------------------------------
//  🚨 型式だけでは意味が無い(決まり12・2026-09-02 清水さん「テンプレによって作業内容かわる」)。
//   最終検査はテンプレの実体が無く、作業内容を分けるのは **特注仕様**(lot.specialConditions)。
//   製品検査ならここに来るのは **テンプレ名**。この畳み方は両方に同じ形で使える様に、
//   何を添えるかを知らない(受け取った文字を畳むだけ)。
//
//  畳む長さの決め方(2026-09-03 実測。控え=2026-08-30 の写し 391ロット・未完了187・特注あり130):
//    文字数 最小3・中央値11・最大34。
//      10文字 … 130件中 57件が畳まずに全文
//      12文字 … 74件
//      14文字 … 89件(68%)   ← ここ
//      16文字 … 91件(+2しか増えない)
//      18文字 … 98件
//    14 を超えると伸びが鈍る一方、札の左列(納期一覧 12.25rem ≒ 全角14字)を越えて型式を押し出す。
//    だから **先頭13文字＋…** で畳み、畳んだ時は title に **型式｜特注仕様の全文** を持つ。
//  🚨 特注仕様が空のロットは「(特注なし)」を作らない。型式だけ出す(空の札を作らない)。
// =============================================================================

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/** 畳まずに出せる文字数(全角換算)。 */
export const SUB_FOLD = 14;

/**
 * @param {string} text 添え書き(特注仕様／テンプレ名)
 * @returns {{full:string, short:string, folded:boolean}} full=全文(空なら'')・short=札に出す文字
 */
export function foldSub(text, limit = SUB_FOLD) {
  const full = clean(text);
  if (!full) return { full: '', short: '', folded: false };
  const chars = Array.from(full);           // サロゲートペア(絵文字等)を1文字と数える
  if (chars.length <= limit) return { full, short: full, folded: false };
  return { full, short: `${chars.slice(0, Math.max(1, limit - 1)).join('')}…`, folded: true };
}

/** 札の title(全文)。添え書きが無い時は型式だけ。 */
export function fullLabelOf(model, text, sep = '｜') {
  const m = clean(model) || '(型式なし)';
  const full = clean(text);
  return full ? `${m}${sep}${full}` : m;
}
