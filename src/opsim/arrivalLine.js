// =============================================================================
//  src/opsim/arrivalLine.js — 納期一覧の「入荷の縦線」を出すか・本当か仮か を決める(純関数・import なし)
// -----------------------------------------------------------------------------
//  🚚 2026-09-18 清水さん「納期の棒あるけど、入荷の棒がないから記載してほしい、仮の棒なのか本当の棒なのかもね」
//  🚨 2026-09-19 メンテで見つけた穴(3つ)。画面の中の if 文を文字で見張っていたので 緑のまま通っていた:
//    ① 最終検査では1本も出ていなかった。最終のエンジンの種類は entryAt／pendingSplit で、製品の言葉(registered…)だけを見ていた。
//    ② arrivalMs が null の行が Number(null)=0 で 1970年の線になり得た。
//    ③ 軸の外(期間より前／後)の入荷が 端へ丸められ「その日に入荷」に見えた。
//  だから 決め方をここへ出し、**値を入れて結果を見る** 試験で見張る。製品検査と最終検査で同じファイル。
// =============================================================================

/** 本当の入荷日: 製品検査=registered／最終検査=entryAt(入荷時間がこれから)・pendingSplit(まだ来ていない便)。 */
export const ARRIVAL_REAL_KINDS = Object.freeze(['registered', 'entryAt', 'pendingSplit']);
/** 仮の入荷日: derived(取込が納期から逆算)／assumed(入荷日が無いので 計算が仮に置いた)。 */
export const ARRIVAL_TENTATIVE_KINDS = Object.freeze(['derived', 'assumed']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 行へ載せる入荷の日時。🚨 null を Number() に通すと 0(1970年)になる。null と 0 以下は「無い」。 */
export function arrivalMsOfLot(lot) {
  if (!lot || lot.arrivalMs == null) return null;
  const n = Number(lot.arrivalMs);
  return isNum(n) && n > 0 ? n : null;
}

/**
 * この行に入荷の線を出すか。
 * @param {{arrivalMs:number|null, arrivalKind:string|null}} row
 * @param {Array<{ms:number,endMs:number}>} cols 軸の列(dueAxis の cols)
 * @returns {null | {ms:number, real:boolean, kind:string}} null＝出さない(もう手元に在る／種類が分からない／軸の外)
 */
export function arrivalLineOf(row, cols) {
  if (!row || !isNum(row.arrivalMs) || row.arrivalMs <= 0) return null;
  const kind = typeof row.arrivalKind === 'string' ? row.arrivalKind : '';
  const real = ARRIVAL_REAL_KINDS.includes(kind);
  if (!real && !ARRIVAL_TENTATIVE_KINDS.includes(kind)) return null;
  // 🚨 軸の位置(xOf)は 軸の外を 0／100 へ丸める。丸めた所へ描くと「その日に入荷」に見えるので、軸の外は出さない。
  if (!Array.isArray(cols) || !cols.length) return null;
  const first = cols[0]; const last = cols[cols.length - 1];
  if (!first || !last || !isNum(first.ms) || !isNum(last.endMs)) return null;
  if (row.arrivalMs < first.ms || row.arrivalMs >= last.endMs) return null;
  return { ms: row.arrivalMs, real, kind };
}

/** 線の言葉。when は画面が作った「9/19 8:30」の形の文字。 */
export function arrivalLineTip(line, when) {
  if (!line) return '';
  if (line.real) return `入荷 ${when}（${line.kind === 'pendingSplit' ? 'まだ来ていない便の到着予定' : '登録された入荷日'}）`;
  return line.kind === 'derived'
    ? `仮の入荷 ${when}（取込が納期から逆算して置いた日。到着を確かめた日ではありません）`
    : `仮の入荷 ${when}（入荷日が無いので、計算が仮に置いた日です）`;
}
