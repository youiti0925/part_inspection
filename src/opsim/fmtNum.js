// 数の書き方（3桁区切り）。🚨 ここで丸めません・作りません。渡された数をそのまま書くだけ。
//   部品(WhyDrawer.jsx)から出すと「部品だけを出すファイル」の決まりに反するので、別ファイルにしています。
export const fmtInt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('ja-JP') : '—');
export default fmtInt;
