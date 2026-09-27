// =============================================================================
//  whatifDiff.js — what-if(シナリオ)と「いつも通り」の引き直し結果の差分(2026-08-29 S2-2)
// -----------------------------------------------------------------------------
//  何をする物か:
//    resampleLotFinish(resample.js)がロットごとに出した「納期までに収まった回数」
//    (onTime = {hit, draws})を、通常(base)とシナリオ(scn)で突き合わせ、
//    「10回中◯回 → 10回中◯回」の変化を並べる。
//
//  掟(CONTRACT.md):
//    ・§5 比較してよいのは土俵(groundKey相当)が完全一致する時だけ。**この関数は
//      土俵の照合をしない**。同じ土俵の結果だけを渡すのは呼ぶ側(盤面)の責任。
//      差が0の物を「改善した/崩れた」とは言わない(summary.same に数えるだけ)。
//    ・純関数。関数の中で現在時刻・乱数を読まない。入力を書き換えない。
//    ・元データに無い値を推測で埋めない。片側にしか結果が無いロットは **数えない**
//      (差を出す材料が揃っていないため。0で埋めると嘘の差が出る)。
//
//  「仮の数字」(provisional)とは:
//    シナリオ側の引き直しで、実測の借り元が階段の遠い段(③工程×型式の全員/④工程の全員)
//    だったジョブが全ジョブ数の過半を占める事。本人の実測ではなく全員の実測から借りた
//    数字が主なので、幅は広めに見るべきという印。ちょうど半分は「仮」にしない
//    (resample.js のピタリ過半判定と同じ倒し方。厳密に半分より多い時だけ)。
// =============================================================================

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const numOr0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * ロット1件の引き直し結果が「差を出せる形」か。
 * ok:true かつ onTime.draws > 0(引き直しが1回も走っていない物は数えない)。
 */
const judgeable = (r) => isObj(r)
  && r.ok === true
  && isObj(r.onTime)
  && Number.isFinite(Number(r.onTime.draws))
  && Number(r.onTime.draws) > 0
  && Number.isFinite(Number(r.onTime.hit));

/** hit/draws → 「10回中◯回」の整数(四捨五入)。 */
const of10Of = (hit, draws) => Math.round((hit / draws) * 10);

/**
 * シナリオ側の provenance.tierCounts から「仮の数字」かを判定する。
 * tierCounts の実形は resample.js: {tier1, tier2, tier3, tier4, fixedNoMaterial}
 * (各ジョブがちょうど1つの箱に入るので、5箱の合計 = 全ジョブ数)。
 * (tier3 + tier4) が全ジョブ数の **厳密に過半** なら仮。ちょうど半分は仮でない。
 */
const provisionalOf = (r) => {
  const tc = isObj(r) && isObj(r.provenance) && isObj(r.provenance.tierCounts)
    ? r.provenance.tierCounts : null;
  if (!tc) return false;
  const far = numOr0(tc.tier3) + numOr0(tc.tier4);
  const total = numOr0(tc.tier1) + numOr0(tc.tier2) + far + numOr0(tc.fixedNoMaterial);
  return total > 0 && far * 2 > total;
};

/**
 * 通常(base)とシナリオ(scn)の引き直し結果(lotId → resampleLotFinish の戻り値)を
 * 突き合わせ、「10回中◯回」の変化の一覧と件数を返す。
 *
 * @param {object} args
 * @param {object} [args.baseByLot] 通常側。lotId → resampleLotFinish の戻り値
 * @param {object} [args.scnByLot]  シナリオ側。同上
 * @param {Map|object|null} [args.lotMetaById] lotId → {orderNo, model}。無ければ空文字
 * @returns {{
 *   rows: Array<{lotId:string, orderNo:string, model:string,
 *     baseHit:number, baseDraws:number, scnHit:number, scnDraws:number,
 *     baseOf10:number, scnOf10:number, delta:number, provisional:boolean}>,
 *   summary: {judgedBoth:number, up:number, down:number, same:number},
 * }} rows の並びは delta昇順(悪くなる物が先=危ない順) → |delta|大きい順 → lotId
 */
export function buildResampleDiff({ baseByLot = {}, scnByLot = {}, lotMetaById = null } = {}) {
  const base = isObj(baseByLot) ? baseByLot : {};
  const scn = isObj(scnByLot) ? scnByLot : {};

  const metaOf = (lotId) => {
    let m = null;
    if (lotMetaById instanceof Map) m = lotMetaById.get(lotId) || null;
    else if (isObj(lotMetaById)) m = lotMetaById[lotId] || null;
    return {
      orderNo: isObj(m) ? str(m.orderNo) : '',
      model: isObj(m) ? str(m.model) : '',
    };
  };

  const rows = [];
  // ⚠ 反復順に依存しない様、鍵は一度並べてから回す(オブジェクトの鍵順は入力の作り方で変わる)。
  const keys = Object.keys(base).sort();
  for (const lotId of keys) {
    // 両側とも判定の材料が揃っているロットだけ。片側しか無い物は数えない(0で埋めると嘘)。
    if (!Object.prototype.hasOwnProperty.call(scn, lotId)) continue;
    const b = base[lotId];
    const s = scn[lotId];
    if (!judgeable(b) || !judgeable(s)) continue;

    const baseHit = Number(b.onTime.hit);
    const baseDraws = Number(b.onTime.draws);
    const scnHit = Number(s.onTime.hit);
    const scnDraws = Number(s.onTime.draws);
    const baseOf10 = of10Of(baseHit, baseDraws);
    const scnOf10 = of10Of(scnHit, scnDraws);
    const { orderNo, model } = metaOf(lotId);
    rows.push({
      lotId: str(lotId),
      orderNo,
      model,
      baseHit,
      baseDraws,
      scnHit,
      scnDraws,
      baseOf10,
      scnOf10,
      delta: scnOf10 - baseOf10,
      provisional: provisionalOf(s),
    });
  }

  // 並び: delta昇順(悪くなる物=負が先。危ない順) → |delta|大きい順 → lotId。
  // ⚠ lotId の比較は < / > で(localeCompare は環境の照合順で結果が揺れるので使わない)。
  rows.sort((a, b) => (a.delta - b.delta)
    || (Math.abs(b.delta) - Math.abs(a.delta))
    || (a.lotId < b.lotId ? -1 : a.lotId > b.lotId ? 1 : 0));

  let up = 0;
  let down = 0;
  let same = 0;
  for (const r of rows) {
    if (r.delta > 0) up += 1;
    else if (r.delta < 0) down += 1;
    else same += 1;
  }

  return {
    rows,
    summary: { judgedBoth: rows.length, up, down, same },
  };
}
