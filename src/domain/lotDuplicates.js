// =============================================================================
//  domain/lotDuplicates.js — 同じ 指図×型式×テンプレ×特注仕様 の未完了ロットが2件以上ある組を数える(2026-09-18／特注仕様を足した 2026-09-22・純関数だけ)
// -----------------------------------------------------------------------------
//  実測(本番の写し 2026-09-18 07:45): 製品検査に 26組52件。8/21 12:40 に作られた物と、9/17 17:46 の進捗管理表の取込が
//    作った物の対。原因は 窓(30日)の中のロットが 599件で 購読の上限500件から 8/21 の53件が溢れ、
//    取込が「既に在る」と分からず作り直した事(readBudget.js の前提2が崩れていた)。
//  🚨 ここは **数えて並べるだけ**。消すのは人(画面の削除の口)。どちらを残すかの **提案** だけ出す:
//    残す = 作業の記録がある物(無ければ 一番古い物)。消す候補 = それ以外で 作業の記録が無い物。
//    記録が両方に在る組は「消す候補なし」(人が見て決める)。
// =============================================================================
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v).trim());
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** 作業の記録があるか(progressSheet.js の hasWork と同じ意味。消してはいけない側)。 */
export function lotHasWork(l) {
  if (!isObj(l)) return false;
  if (isObj(l.tasks) && Object.keys(l.tasks).length > 0) return true;
  if (l.status === 'processing' || l.status === 'paused') return true;
  if (num(l.workStartTime) > 0) return true;
  if (num(l.totalWorkTime) > 0) return true;
  if (Array.isArray(l.interruptions) && l.interruptions.length > 0) return true;
  if (num(l.currentStepIndex) > 0) return true;
  return false;
}

export const isOpenLot = (l) => isObj(l) && !(l.status === 'completed' || l.location === 'completed');

/**
 * 🚨 特注仕様(最終検査の lot.specialConditions)。並びが違うだけの物を別扱いにしない為に
 *   前後の空白を落として重複を除き、並べ替えてから1本の文字にする。
 *   製品検査にはこの欄が無いので常に '' = 今までと1バイトも同じ鍵になる。
 */
export function specKeyOf(l) {
  const raw = isObj(l) && Array.isArray(l.specialConditions) ? l.specialConditions : [];
  const names = [...new Set(raw.map(str).filter(Boolean))].sort();
  return names.join('\u241F');
}

/**
 * @param {Array} lots
 * @returns {Array<{ key, orderNo, model, templateId, specKey, specialConditions, lots: Array<{id, createdAt, hasWork, importSource, dueDate, entryAt, quantity, status}>, keepId, removeIds }>}
 *   組は 指図の昇順。組の中は 作成の古い順。
 */
/** 工程の並び(id か題名)。同じ指図・型式でも工程構成が違えば同じ物と決めない。 */
export function stepShapeOf(l) {
  const steps = isObj(l) && Array.isArray(l.steps) ? l.steps : [];
  return steps.map((s) => str(isObj(s) ? (s.id ?? s.title ?? s.name) : s)).join('\u241F');
}
/** 鍵には入れないが「同じ物」と決める前に見る欄。1つでも違えば一括削除の候補にしない(人が見る)。 */
export const DUP_REVIEW_FIELDS = Object.freeze([
  ['quantity', '数量', (l) => String(num(l.quantity))],
  ['stepShape', '工程構成', stepShapeOf],
  ['appearanceNote', '外観メモ', (l) => str(l.appearanceNote)],
  ['simpleSpec', '簡易仕様', (l) => str(l.simpleSpec)],
]);
export function reviewDifferencesOf(list = []) {
  const out = [];
  for (const [key, label, read] of DUP_REVIEW_FIELDS) {
    const vals = new Set(list.map((l) => read(l)));
    if (vals.size > 1) out.push({ key, label });
  }
  return out;
}

export function duplicateOpenLotsOf(lots = []) {
  const groups = new Map();
  for (const l of (Array.isArray(lots) ? lots : [])) {
    if (!isOpenLot(l)) continue;
    const orderNo = str(l.orderNo);
    if (!orderNo) continue;
    // 🚨 特注仕様も鍵に入れる(2026-09-22)。最終検査はテンプレが無いので、
    //   入れないと 特注色 と 輸出仕様 が同じ組になり、片方が「消せる重複」に並ぶ。
    const key = `${orderNo}|${str(l.model)}|${str(l.templateId)}|${specKeyOf(l)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  const out = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const rows = list
      .map((l) => ({ id: str(l.id), createdAt: num(l.createdAt), hasWork: lotHasWork(l), importSource: str(l.importSource), dueDate: str(l.dueDate), entryAt: num(l.entryAt) || null, quantity: num(l.quantity) || null, status: str(l.status) }))
      .sort((a, b) => (a.createdAt - b.createdAt) || a.id.localeCompare(b.id));
    const withWork = rows.filter((r) => r.hasWork);
    // 残す1件: 記録がある物が1件ならそれ。0件なら一番古い物。2件以上なら決めない(人が見る)。
    const keep = withWork.length === 1 ? withWork[0] : (withWork.length === 0 ? rows[0] : null);
    // 🚨 2026-09-22 数量・工程構成・外観メモ・簡易仕様が違う組は「同じ物」と決めない。
    //   鍵には足さない(足すと重複そのものを見落とす)。一括削除の候補から外し、何が違うかを人に見せる。
    const differs = reviewDifferencesOf(list);
    const removeIds = keep && differs.length === 0 ? rows.filter((r) => r.id !== keep.id && !r.hasWork).map((r) => r.id) : [];
    const [orderNo, model, templateId, specKey] = key.split('|');
    out.push({ key, orderNo, model, templateId, specKey, specialConditions: specKey ? specKey.split('\u241F') : [], lots: rows, keepId: keep ? keep.id : null, removeIds,
      needsReview: differs.length > 0, differs });
  }
  return out.sort((a, b) => a.orderNo.localeCompare(b.orderNo) || a.key.localeCompare(b.key));
}

/** 人が読む1文。 */
export function duplicateSummaryText(groups = []) {
  const g = Array.isArray(groups) ? groups : [];
  if (!g.length) return '';
  const lots = g.reduce((n, x) => n + x.lots.length, 0);
  const removable = g.reduce((n, x) => n + x.removeIds.length, 0);
  return `同じ指図×型式×テンプレの未完了ロットが ${g.length}組（${lots}件）あります。記録の無い ${removable}件は消せます`;
}

export default duplicateOpenLotsOf;
