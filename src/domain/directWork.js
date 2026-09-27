// ============================================================================
// 🔧 直工(直接作業)の時間取り — 検査作業以外の「直接作業」も選んで測る
// ----------------------------------------------------------------------------
// 清水さん(2026-08-10):
//   「間接作業を選択できるところあるけど、直工作業でも選択して時間取りする機能ほしいかな。
//     直工作業は実際の検査作業だけじゃないこともあるから。」
//
// ⚠⚠ この機能でいちばん危ないのは **数字が食い違うこと**。
//   直工の時間を足すと、直間比率・実測係数・必要人数・人件費・月次が全部動く。
//   1つでも足し忘れると「合計が合わない」になり、直したことより信用を失う。
//   → 「どの集計に足すか / 足さないか」をこのファイルに **1か所で** 定義し、
//     画面はここを通してしか数えない。
//
// ⚠⚠ 保存先は **間接作業と同じコレクション**(indirectWork)に `kind` を足すだけにする。
//   別コレクションにすると、既存の「間接の集計」が新しい記録を **黙って無視** する
//   (=間接だけ見ている画面と、両方見ている画面で数字が食い違う)。
//   同じ棚に入れて `kind` で分ければ、**既存の集計は必ずどちらかを選ばされる**。
//   ⚠だから既存の消費側は全部 `isIndirect()` / `isDirectOther()` を通すこと。
//
// ⚠ここには React も firebase も import しない (node --test で回すため)。
// ============================================================================

export const WORK_KIND = Object.freeze({ INDIRECT: 'indirect', DIRECT_OTHER: 'directOther' });

/**
 * ⚠既存の記録には kind が無い。**無い物は今までどおり「間接」**として数える。
 *   ここを間違えると、過去の間接作業が全部 直工に化けて直間比率が壊れる。
 */
export const kindOf = (w) => (w && w.kind === WORK_KIND.DIRECT_OTHER ? WORK_KIND.DIRECT_OTHER : WORK_KIND.INDIRECT);
export const isIndirect = (w) => kindOf(w) === WORK_KIND.INDIRECT;
export const isDirectOther = (w) => kindOf(w) === WORK_KIND.DIRECT_OTHER;

/**
 * 直工だが検査作業ではない物の既定。⚠設定で変えられる(決めつけない)。
 * @param app 'product' | 'final'
 * ⚠⚠ 最終検査では「梱包・出荷準備」を既定に入れない。
 *   荷姿写真の時間が既に **直工として** 別経路(packagingTimeSessions)で数えられており、
 *   同じ作業が二重計上される(2026-08-10 の設計レビューで指摘)。
 */
export const defaultDirectCategories = (app) => {
  const common = ['段取り替え', '治具・工具の準備', '材料・部品の手配', '手直し・やり直し', '運搬・移動', '立会い・確認', 'その他(直工)'];
  return app === 'final' ? common : ['梱包・出荷準備', ...common];
};

export const directCategoriesOf = (settings, app) => {
  const list = settings && Array.isArray(settings.directCategories) ? settings.directCategories.filter(Boolean) : null;
  return (list && list.length) ? [...new Set(list)] : defaultDirectCategories(app);
};

/** 記録1件の秒数。⚠進行中(終わっていない)は 0 にする。終わっていない時間を足すと毎秒変わる数字になる。 */
export const secOf = (w) => {
  const d = Number(w && w.duration);
  return Number.isFinite(d) && d > 0 ? d : 0;
};

const inRange = (w, from, to) => {
  const raw = (w && w.endTime != null) ? w.endTime : (w && w.startTime);
  const t = Number(raw);
  if (!Number.isFinite(t)) return false;
  if (from != null && t < from) return false;
  if (to != null && t > to) return false;
  return true;
};

/**
 * 期間内の秒数を、種別ごとに集計する。
 * ⚠⚠ `overlap` = **検査作業をしながら回っていた直工の時間**。
 *   これを黙って足すと同じ時間が2回数えられる。だから:
 *     ・`directOther` … 直工その他の合計(重なりを含む)
 *     ・`directOtherExclusive` … 重なりを除いた分 ← **人件費・係数はこちらを使う**
 *     ・`overlap` … 重なった分(画面に必ず出す。隠さない)
 * @param lotBusyRanges [{from,to}] 検査作業をしていた区間(重なり判定用)。空なら重なり0。
 */
export const sumByKind = (rows, { from = null, to = null, lotBusyRanges = [] } = {}) => {
  let indirect = 0, directOther = 0, overlap = 0;
  for (const w of (rows || [])) {
    if (!w || !inRange(w, from, to)) continue;
    const sec = secOf(w);
    if (sec <= 0) continue;
    if (isIndirect(w)) { indirect += sec; continue; }
    directOther += sec;
    overlap += overlapSec(w, lotBusyRanges);
  }
  return {
    indirect, directOther, overlap,
    directOtherExclusive: Math.max(0, directOther - overlap),
  };
};

/** その記録が、検査作業の区間とどれだけ重なっていたか(秒)。 */
export const overlapSec = (w, ranges) => {
  // ⚠ `Number(x) || 0` で判定しない。**0 が「無い」と誤判定される**(テストが検出)。
  //   時刻は数として妥当かどうかで見る。
  const s = Number(w && w.startTime);
  const e = Number(w && w.endTime);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return 0;
  let acc = 0;
  for (const r of (ranges || [])) {
    const rf = Number(r && r.from), rt = Number(r && r.to);
    if (!Number.isFinite(rf) || !Number.isFinite(rt)) continue;
    const a = Math.max(s, rf);
    const b = Math.min(e, rt);
    if (b > a) acc += Math.floor((b - a) / 1000);
  }
  return Math.min(acc, Math.floor((e - s) / 1000));
};

/**
 * 「間接込み係数」。⚠⚠ **分母は検査タスクの時間に固定する**。
 *   この係数は「検査タスクの時間(weeklyWorkload)」に掛けるための物なので、
 *   分母に直工その他を足すと **掛ける相手と物差しが変わり、必要人数と実効キャパが逆方向に動く**
 *   (2026-08-10 の設計レビューで指摘された blocker)。
 *   分子にだけ上乗せする: (検査 + 直工その他 + 間接) / 検査
 * ⚠直工その他は **重なりを除いた分** を使う(二重計上を係数に持ち込まない)。
 */
export const inclusiveFactor = ({ inspectionSec = 0, directOtherExclusiveSec = 0, indirectSec = 0 } = {}) => {
  const d = Number(inspectionSec) || 0;
  if (d <= 0) return 1;
  return (d + (Number(directOtherExclusiveSec) || 0) + (Number(indirectSec) || 0)) / d;
};

/** 係数の説明文。⚠数字には必ず出どころを添える(この現場の決まり)。 */
export const factorNote = ({ inspectionSec = 0, directOtherExclusiveSec = 0, indirectSec = 0, overlapSec: ov = 0 } = {}) => {
  const h = (s) => (s / 3600).toFixed(1);
  const base = `検査 ${h(inspectionSec)}h に対し、直工その他 ${h(directOtherExclusiveSec)}h ＋ 間接 ${h(indirectSec)}h を上乗せした係数`;
  return ov > 0 ? `${base}（うち検査と重なっていた ${h(ov)}h は除いています）` : base;
};
