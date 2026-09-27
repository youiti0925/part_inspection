// =============================================================================
//  domain/importExistingCheck.js — 取込の前に「その指図のロットがサーバに在るか」を確かめる為の純関数(2026-09-18 夕)
// -----------------------------------------------------------------------------
//  🚨 事故(2026-09-17 17:46): 進捗管理表の取込は「画面に読めているロット」だけを見て 在る／無い を決めていた。
//    ロットの購読には上限(窓30日・新しい順500件)が在り、8/21 に作った未完了 53件が画面から溢れていた。
//    取込はそれを「無い」と判断して 同じ指図×テンプレを 26組 作り直し、現場には「同じ指図が2つ」
//    「途中までやっていたロットが消えた(見えない方に記録が在った)」と見えた。
//  直し: 取込は **サーバへ 指図番号で問い合わせてから** 判定する。画面に何が読めているかに頼らない。
//    ・表を読んだ直後(プレビューを作る前)に1回
//    ・確定を押して **書く直前にもう1回**(別の端末が同じ表を先に取り込んだ時も二重に作らない)
//    ・問い合わせに失敗したら **取込を止める**(分からないまま作らない)
//  ここは数えて束ねるだけ。読むのは呼ぶ側(App の窓口 getPage)。
// =============================================================================
const str = (v) => (v == null ? '' : String(v).trim());

/** Firestore の in は1回に30個まで。 */
export const IN_MAX = 30;

/** 表の行から、問い合わせる指図番号(重複なし・空は除く)。 */
export function orderNosOfRows(rows) {
  const out = new Set();
  for (const r of (Array.isArray(rows) ? rows : [])) { const o = str(r && r.orderNo); if (o) out.add(o); }
  return [...out];
}

/** 30個ずつに分ける。 */
export function orderNoChunks(orderNos, size = IN_MAX) {
  const list = [...new Set((Array.isArray(orderNos) ? orderNos : []).map(str).filter(Boolean))];
  const n = Math.max(1, Math.min(IN_MAX, Number(size) || IN_MAX));
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** 1回ぶんの問い合わせの指定(窓口 getPage へ渡すただの配列)。単一項目の索引で足りる。 */
export const orderNoLotsSpec = (chunk) => ({ where: [['orderNo', 'in', [...chunk]]] });

/**
 * 画面に読めているロット ＋ サーバから取り寄せたロット を id で1つにする。
 *   同じ id は **画面の方を残す**(生きた購読の方が新しい)。足すのは 画面に無かった物だけ。
 * @returns {{ lots: Array, added: Array<{id, orderNo, model, templateId, done}>, addedOpen: number, addedDone: number }}
 */
export function mergeLotsForImport(loaded, fetched) {
  const base = Array.isArray(loaded) ? loaded : [];
  const have = new Set(base.map((l) => str(l && l.id)).filter(Boolean));
  const lots = [...base];
  const added = [];
  for (const l of (Array.isArray(fetched) ? fetched : [])) {
    const id = str(l && l.id);
    if (!id || have.has(id)) continue;
    have.add(id);
    lots.push(l);
    const done = l.status === 'completed' || l.location === 'completed';
    added.push({ id, orderNo: str(l.orderNo), model: str(l.model), templateId: str(l.templateId), done });
  }
  return { lots, added, addedOpen: added.filter((a) => !a.done).length, addedDone: added.filter((a) => a.done).length };
}

/** 作る行の身元(指図×テンプレ)。取込が「既に在る」を決めるのと同じ鍵。 */
export const createKeyOf = (c) => `${str(c && c.orderNo)}|${str(c && c.templateId)}`;

/**
 * 書く直前の確かめ直し: プレビューの時に「作る」と決めた行のうち、確かめ直した計画でも「作る」に残っている物だけを通す。
 * @returns {{ keep: Array, dropped: Array }}
 */
export function dropAlreadyExisting(createLots, freshCreateLots) {
  const fresh = new Set((Array.isArray(freshCreateLots) ? freshCreateLots : []).map(createKeyOf));
  const keep = []; const dropped = [];
  for (const c of (Array.isArray(createLots) ? createLots : [])) (fresh.has(createKeyOf(c)) ? keep : dropped).push(c);
  return { keep, dropped };
}

/** 人が読む1文(プレビューに出す)。 */
export function serverCheckText(check) {
  if (!check) return '';
  const asked = Number(check.asked) || 0;
  const added = Number(check.added) || 0;
  if (!added) return `サーバに ${asked}指図を問い合わせて確かめました（画面に読めていないロットはありません）`;
  return `サーバに ${asked}指図を問い合わせて確かめました。画面に読めていなかったロット ${added}件（未完了 ${Number(check.addedOpen) || 0}・完了 ${Number(check.addedDone) || 0}）も 既に在る物として判定しています`;
}
