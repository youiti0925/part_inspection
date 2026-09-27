// =============================================================================
//  atRisk.js — 「危険なロット」の数え方を **1か所だけ** に置く
// -----------------------------------------------------------------------------
//  なぜこのファイルを作ったか(2026-09-01 矛盾Aの直し):
//    同じ画面の同じ言葉『一番効く手』が、2つの違う計算から出ていた。
//      ・今日の判断 … explain.js buildRemedies
//          ものさし = `r.late === true` の件数。**すでに納期を過ぎた物も入る**。
//      ・改善・教育 … scenarios.js rankImprovements
//          ものさし = atRiskLotCount
//          =(この先で遅れる) ∪ (納期があるのに手が付かない)。すでに過ぎた物は入らない。
//    数の意味が違うので、同じ手を並べても違う数が出る。
//    2026-08-30 に決めた「主因は1つの計算結果から全表示へ配る」と同じ形へ直す。
//
//  🚨 ものさしは **危険なロット** に寄せた。理由は 2026-08-22 の決まり
//     「すでに超過 / この先の見込み / 判定できない を混ぜるな」。
//     `late === true` には「すでに納期を過ぎた物」が入っている。あれは今日の事実で、
//     どんな手を打っても1件も減らない。効き目の引き算に入れたままにすると、
//     打っても減らない分がずっと居座り、手の効き目が小さく見える。
//
//  🚨 和集合であって足し算ではない。「遅れる」と「手が付かない」の両方に当てはまる
//     ロットを足すと二重に数える(仕様書5.8 の但し書き)。
//
//  ⚠ 純関数だけ。Date.now / Math.random / localeCompare を使わない(S23)。
//  ⚠ Firestore は読まない・書かない(S24)。
// =============================================================================

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/**
 * 🚨 数として読む。読めなければ null。
 *   ⚠ `Number(null)` は **0** になる。素直に Number.isFinite(Number(v)) と書くと
 *     「納期線が無い(null)」が「納期線 = 1970年(0)」に化け、
 *     納期の無いロットが『納期があるのに手が付かない』に数えられる(実際に起きた)。
 */
const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * 手が付かなかった仕事(unresolved)から、どのロットの物かを取り出す。
 *
 * 🚨 simulate.js の classifyUnresolved が push しているのは `{ jobId, reason }` **だけ**で、
 *   lotId は入っていない(simulate.js:1136 で確認)。lotId が無いまま数えると
 *   「納期線があるのに手が付かないロット」が **0件** になり、危険件数が小さく出る。
 * jobId は buildJobs.js:180/196 で `${lotId}#${stepIndex}#${unit|'lot'}` と作られる。
 *   ⚠ lotId 自体に '#' が入っていても壊れないよう、**後ろ2つを落とす**形で戻す
 *      (split('#')[0] だと '#' 入りの lotId で切れる)。
 * ⚠ 将来 simulate 側が lotId を持たせたら、そちらを優先する。
 *
 * ⚠ 2026-09-01: 元は scenarios.js に居た。危険件数の式と一緒に置かないと
 *   「同じ数を2か所で作る」形に戻るので、こちらへ移した。scenarios.js は再輸出している。
 */
export function lotIdOfUnresolved(entry) {
  if (!isObj(entry)) return '';
  if (entry.lotId != null && String(entry.lotId)) return String(entry.lotId);
  const jid = String(entry.jobId == null ? '' : entry.jobId);
  if (!jid) return '';
  const parts = jid.split('#');
  if (parts.length < 3) return '';
  return parts.slice(0, -2).join('#');
}

/**
 * 危険なロットの内訳。**この関数だけが数え方を持つ。**
 *
 * @param {object} simResult simulateOperations の戻り値
 * @returns {{
 *   lotIds: Set<string>,            危険なロット(和集合)
 *   count: number,                  その件数
 *   forecastLateLotIds: Set<string>,この先で遅れる(すでに過ぎた物は入らない)
 *   unresolvedLotIds: Set<string>,  手が付かなかったロット(納期線の有無を問わない)
 *   unresolvedDueLotIds: Set<string>,そのうち納期線を持つ物
 *   alreadyPastDueLotIds: Set<string>, すでに納期を過ぎている(今日の事実。危険には入れない)
 *   provisionalDueLotIds: Set<string>, 納期が **仮**(進捗管理表の Y列/AB列から作った)。危険には入れない
 * }}
 */
export function atRiskBreakdown(simResult) {
  const res = isObj(simResult) ? simResult : {};
  const rows = arr(res.lotResults).filter(isObj);

  const forecastLateLotIds = new Set();
  const alreadyPastDueLotIds = new Set();
  // 🚩 納期が **仮** のロット(進捗管理表の Y列/AB列から作った物。dueKind:'provisional')。
  //   2026-08-22 の決まり「すでに超過 / この先の見込み / 判定できない を混ぜるな」の **判定できない** 側。
  //   組立の開始日から作った日付で「遅れます」と言うと、打つ手の効き目の引き算まで嘘になる。
  //   ⚠ 印が付いていない今までのデータでは この集合は空 = 数え方は1件も変わらない。
  const provisionalDueLotIds = new Set();
  const dueLineByLot = new Map();
  rows.forEach((r) => {
    if (r.lotId == null) return;
    const id = String(r.lotId);
    dueLineByLot.set(id, num(r.dueLineMs));
    if (r.dueKind === 'provisional') provisionalDueLotIds.add(id);
    if (r.alreadyPastDue === true) alreadyPastDueLotIds.add(id);
    // 🚨 すでに過ぎている物は「この先で遅れる」に入れない。手を打っても減らないため。
    if (r.late === true && r.alreadyPastDue !== true && r.dueKind !== 'provisional') forecastLateLotIds.add(id);
  });

  const unresolvedLotIds = new Set();
  arr(res.unresolved).forEach((u) => {
    const id = lotIdOfUnresolved(u);
    if (id) unresolvedLotIds.add(id);
  });

  const unresolvedDueLotIds = new Set();
  unresolvedLotIds.forEach((id) => {
    // ⚠ 納期線が無い物は「納期を守れない」とは言えない。数えない。
    // ⚠ 仮の納期も同じ扱い(その日付は組立の予定から作った物で、検査の納期ではない)。
    if (dueLineByLot.get(id) != null && !provisionalDueLotIds.has(id)) unresolvedDueLotIds.add(id);
  });

  // 🚨 和集合。足し算にしない。
  const lotIds = new Set(forecastLateLotIds);
  unresolvedDueLotIds.forEach((id) => lotIds.add(id));

  return {
    lotIds,
    count: lotIds.size,
    forecastLateLotIds,
    unresolvedLotIds,
    unresolvedDueLotIds,
    alreadyPastDueLotIds,
    provisionalDueLotIds,
  };
}

/** 危険なロットの件数。効き目の引き算はこの数だけで行う。 */
export function atRiskCount(simResult) {
  return atRiskBreakdown(simResult).count;
}

export default atRiskBreakdown;
