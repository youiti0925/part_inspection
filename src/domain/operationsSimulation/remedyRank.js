// =============================================================================
//  remedyRank.js — 『一番効く手』の **並べ方と選び方を1か所だけ** に置く
// -----------------------------------------------------------------------------
//  2026-09-01 矛盾Aの直し。直す前はこうなっていた:
//
//    今日の判断   explain.js:389-450 buildRemedies
//                 ものさし = 遅れるロットが何件減るか(すでに過ぎた物も込み)
//                 顔ぶれ   = 人が押していない「全員がどの工程も持てる」を**黙って混ぜる**
//                           (explain.js:430)。しかも worker.js:411 は scenarios:[] を
//                           渡しているので、**測定済みの手はその1つだけ**だった。
//                           つまり今日の判断の『一番効く手』は、押した手に関係なく
//                           いつも「全員がどの工程も持てるようにする」になっていた。
//    改善・教育   scenarios.js:628-657 rankImprovements
//                 ものさし = 危険なロットが何件減るか
//                 顔ぶれ   = 人が押した手だけ
//
//  → 同じ言葉で違う数・違う顔ぶれ。**1つの規則へ寄せる。**
//
//  寄せ方（この3つで、どちらの画面から呼んでも同じ答えになる）:
//    ① ものさしは atRisk.js の「危険なロット」ただ1つ(atRisk.js の頭を読む事)。
//    ② 並べ方は effect の大きい順 → 同点なら key の昇順(端末の言語データに依らない)。
//    ③ **『一番効く手』に選べるのは、人が押した手(pressed:true)だけ。**
//       押していない仮定は best にしない。別の名前 `ceiling`(上限)で返し、
//       画面はその名前で別に出す。
//       🚨 押していない条件を『一番効く手』として黙って出さない、という決まり
//          （押した手が1つも無い時に「全員がどの工程も持てるようにする」と出ていた）。
//
//  ⚠ 純関数だけ。Date.now / Math.random / localeCompare を使わない(S23)。
// =============================================================================

/** 効き目のものさしの名前。画面はこれで「何の件数か」を出す。 */
export const REMEDY_MEASURE = 'atRiskLotCount';

/** 画面へそのまま出す、ものさしの説明。🚨 2画面で同じ文を使う。 */
export const REMEDY_MEASURE_LABEL = '危険なロット（この先で遅れる ＋ 納期があるのに手が付かない）の件数';

/** 押していない仮定に必ず添える断り書き。🚨 これを外して数字だけ出さない。 */
export const REMEDY_ASSUMPTION_NOTE = '全員がどの工程も持てるとした場合';

/** 上限（押していない仮定）の見出し。best と**必ず違う言葉**にする。 */
export const REMEDY_CEILING_TITLE = '手が届く上限（押していない仮定）';

/** 『一番効く手』の見出し。2画面で同じ言葉を使う。 */
export const REMEDY_BEST_TITLE = '一番効く手（押して計算した手の中で）';

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

const num = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** ⚠ localeCompare を使わない(端末の言語データで並びが変わると S23 が崩れる)。 */
const cmpKey = (a, b) => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
};

/**
 * 手を並べて、『一番効く手』と『上限』を選ぶ。
 *
 * @param {object} args
 * @param {Array<{key:string,label:string,effect:number|null,pressed:boolean,assumption:string|null}>} args.items
 *   effect … 危険なロットが何件**減る**か(正が良くなる)。測っていなければ null。
 *   pressed … 人がその手を押して計算したか。押していない仮定は false。
 *   assumption … 押していない仮定の断り書き。無ければ null。
 * @returns {{ranked:Array, best:object|null, ceiling:object|null,
 *            measure:string, measureLabel:string}}
 */
export function rankRemedies({ items = [] } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter(isObj)
    .map((it) => {
      const pressed = it.pressed === true;
      return {
        ...it,
        key: String(it.key == null ? (it.label == null ? '' : it.label) : it.key),
        label: String(it.label == null ? '' : it.label),
        effect: num(it.effect),
        effectUnit: '件',
        measure: REMEDY_MEASURE,
        pressed,
        // 🚨 押していない仮定には必ず断り書きを付ける。呼ぶ側が忘れたらここで付ける。
        assumption: pressed ? null : (it.assumption == null ? REMEDY_ASSUMPTION_NOTE : String(it.assumption)),
      };
    });

  // 並べ方。効き目のある物が先、測っていない物(null)は最後。同点は key の昇順。
  const ranked = [...list].sort((a, b) => {
    const av = a.effect;
    const bv = b.effect;
    if (av == null && bv == null) return cmpKey(a.key, b.key);
    if (av == null) return 1;
    if (bv == null) return -1;
    return (bv - av) || cmpKey(a.key, b.key);
  });

  // 🚨 『一番効く手』は **押した手だけ** から選ぶ。
  //   押していない仮定をここへ入れると、押していない条件が答えの顔をする。
  const best = ranked.find((m) => m.pressed === true && (m.effect || 0) > 0) || null;

  // 押していない仮定の上限。**best とは別の名前**で返す(画面も別の言葉で出す)。
  const ceiling = ranked.find((m) => m.pressed !== true && (m.effect || 0) > 0) || null;

  return {
    ranked,
    best,
    ceiling,
    measure: REMEDY_MEASURE,
    measureLabel: REMEDY_MEASURE_LABEL,
  };
}

export default rankRemedies;
