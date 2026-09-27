// =============================================================================
//  arrivalAccounting.js — 入荷日の件数を **1つの計算から** 出す
// -----------------------------------------------------------------------------
//  なぜこのファイルを作ったか(2026-09-01 矛盾Bの直し):
//    同じ画面が、同じロットの事を逆に言っていた。
//
//      帯   OperationsSimulationPanel.jsx:2029
//           「⚠ 入荷日が無い N件を『納期の2日前に着く』と仮に置いて計算しています。」
//           N = normalizeInput の unknowns.arrivalAssumed の件数
//
//      カード opsim/Header.jsx:1118（材料は同 739-744 の arrivalShort）
//           「到着の情報が足りないロット M件は、この見立てに入れていません。」
//           M = inputQuality.arrivalOverdueCount + arrivalUnknownCount
//
//    実測 N=3 / M=4。**4件のうち3件は計算に入っているのに「入れていません」** と
//    書かれていた。仮置きは 2026-08-31 から既定でONなので、開くと必ずこの状態になる。
//
//    食い違いの元は normalizeInput.js の書く順番:
//      :685 / :693  到着が分からない・予定超過のロットを arrivalOverdue / arrivalUnknown へ入れる
//      :702-713     そのあと仮の入荷日を当てて arrivalAssumed へも入れる
//                   🚨 このとき **arrivalOverdue / arrivalUnknown からは外していない**。
//      → 「足りない」の箱に入ったまま「仮で入れた」の箱にも入る。
//        カードは前者だけを数え、帯は後者だけを数えていた。
//
//    直し方: 箱の出入りをここ1か所で決め、**帯の文もカードの文も同じ物から作る**。
//      到着の情報が足りない(short) = 仮に置いて計算に入れた(assumed)
//                                  + この見立てに入れていない(excluded)
//    この足し算が崩れたら試験が落ちる（arrival-accounting.test.mjs）。
//
//  ⚠ 純関数だけ。Date.now / Math.random / localeCompare を使わない(S23)。
//  ⚠ Firestore は読まない・書かない(S24)。元のデータには1文字も書き戻さない。
// =============================================================================

const arr = (v) => (Array.isArray(v) ? v : []);
const idsOf = (v) => arr(v).map((x) => String(x == null ? '' : x)).filter((s) => s !== '');

/** ⚠ localeCompare を使わない(端末の言語データで並びが変わると S23 が崩れる)。 */
const cmpId = (a, b) => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
};
const sorted = (set) => [...set].sort(cmpId);

/**
 * 入荷日の件数の内訳。**帯もカードもここから作る。**
 *
 * @param {object} args
 * @param {object} args.unknowns normalizeInput の unknowns
 *   （arrivalOverdue / arrivalUnknown / arrivalAssumed / dueUnknown の lotId 配列）
 * @param {number|null} [args.assumeArrivalDaysBeforeDue]
 *   仮に置く日数。null なら「仮に置かない」。🚨 0件でもON/OFFを言い分けるので必ず渡す。
 * @returns {object}
 */
export function buildArrivalAccounting({ unknowns = {}, assumeArrivalDaysBeforeDue = null } = {}) {
  const u = unknowns && typeof unknowns === 'object' ? unknowns : {};

  const overdue = new Set(idsOf(u.arrivalOverdue));
  const unknown = new Set(idsOf(u.arrivalUnknown));
  const dueUnknown = new Set(idsOf(u.dueUnknown));
  const assumedRaw = new Set(idsOf(u.arrivalAssumed));
  // 🚨 2026-09-04: 仮に置いた日の2通り。normalizeInput が分けた物を **そのまま** 受け取る。
  //   ここで日付から数え直さない（数え直すと同じ数字が2つの計算から出る）。
  const assumedClampedRaw = new Set(idsOf(u.arrivalAssumedClamped));
  const assumedBeforeDueRaw = new Set(idsOf(u.arrivalAssumedBeforeDue));

  // 到着の情報が足りないロット。🚨 和集合。足し算にすると、
  //   「予定超過」と「日時が分からない」の両方に入る事は無いはずだが、
  //   将来どちらにも push する道が出来た時に二重に数えるのを防ぐ。
  const shortIds = new Set([...overdue, ...unknown]);

  // 仮の入荷日を当てて計算に入れた物。
  // ⚠ 仮を当てられるのは assignable=false の物だけ(normalizeInput.js:702)なので、
  //   assumed は必ず short の中に入る。**その前提が崩れたら黙って捨てず表に出す。**
  const assumedIds = new Set();
  const strayAssumedIds = new Set();
  assumedRaw.forEach((id) => {
    if (shortIds.has(id)) assumedIds.add(id);
    else strayAssumedIds.add(id);
  });

  // 🚨 2026-09-04 仮に置いた日の2通りへ割る。**どちらとも書いていない物を黙って片方へ寄せない**。
  //   寄せた瞬間に「納期の2日前に置いた」の件数が水増しされ、いま直している嘘に戻る。
  //   3つの合計が assumedCount と一致する（一致しなければ見張りが赤）。
  const assumedClamped = new Set();
  const assumedBeforeDue = new Set();
  const assumedKindUnknown = new Set();
  assumedIds.forEach((id) => {
    if (assumedClampedRaw.has(id)) assumedClamped.add(id);
    else if (assumedBeforeDueRaw.has(id)) assumedBeforeDue.add(id);
    else assumedKindUnknown.add(id);
  });

  // この見立てに入れていない物 = 足りない物のうち、仮でも入らなかった物。
  const excludedIds = new Set();
  shortIds.forEach((id) => { if (!assumedIds.has(id)) excludedIds.add(id); });

  // 入荷日も納期も無い＝起点が無いので仮にも置けない物。
  // 🚨 黙って上の数に混ぜない(2026-08-22「3つの数を混ぜるな」と同じ形)。
  const noAnchorIds = new Set();
  shortIds.forEach((id) => { if (dueUnknown.has(id)) noAnchorIds.add(id); });

  // 仮に置けば計算に入る見込みの物(納期がある)。OFFの時に「押せば動く」を言うのに使う。
  const anchoredIds = new Set();
  shortIds.forEach((id) => { if (!dueUnknown.has(id)) anchoredIds.add(id); });

  const assumeOn = assumeArrivalDaysBeforeDue != null && Number.isFinite(Number(assumeArrivalDaysBeforeDue));

  return {
    assumeOn,
    assumeDaysBeforeDue: assumeOn ? Number(assumeArrivalDaysBeforeDue) : null,

    /** 到着の情報が足りないロット（予定超過 ＋ 到着日時が分からない）。 */
    shortCount: shortIds.size,
    shortLots: sorted(shortIds),

    /** そのうち、仮の入荷日を置いて **計算に入れた** 物。帯が言う数（下の2つの合計）。 */
    assumedCount: assumedIds.size,
    assumedLots: sorted(assumedIds),

    /**
     * 🚨 2026-09-04 清水さん「納期の2日前に着くって話なのに 添付で見たら全然違う」。
     *   「仮に置いた」を **1つの数で言うと嘘になる**。2つに割って最後まで運ぶ:
     *     assumedBeforeDue … 納期のN日前に置けた（帯の言葉どおり）
     *     assumedClamped   … N日前がもう過ぎていたので基準時刻に置いた（言葉と違う）
     *   ⚠ assumedBeforeDueCount + assumedClampedCount == assumedCount。
     *     崩れたら arrival-accounting.test.mjs と見張りが赤になる。
     */
    assumedBeforeDueCount: assumedBeforeDue.size,
    assumedBeforeDueLots: sorted(assumedBeforeDue),
    assumedClampedCount: assumedClamped.size,
    assumedClampedLots: sorted(assumedClamped),

    /**
     * 🚨 どちらとも書かれていない物。**0件が正しい**。
     *   0件でない時は normalizeInput が印を付け損ねている。黙って「納期のN日前」へ寄せず、
     *   分からないと言う（2026-08-22「判定できないを他の数に混ぜるな」と同じ形）。
     */
    assumedKindUnknownCount: assumedKindUnknown.size,
    assumedKindUnknownLots: sorted(assumedKindUnknown),

    /** そのうち、**この見立てに入れていない** 物。カードが言う数。 */
    excludedCount: excludedIds.size,
    excludedLots: sorted(excludedIds),

    /** 入荷日も納期も無いので仮にも置けない物（excluded の内訳）。 */
    noAnchorCount: noAnchorIds.size,
    noAnchorLots: sorted(noAnchorIds),

    /** 納期があるので仮に置けば動く見込みの物（OFFの時の「押せば動く」件数）。 */
    anchoredCount: anchoredIds.size,
    anchoredLots: sorted(anchoredIds),

    /**
     * 🚨 前提が崩れた印。short に入っていないのに assumed に居るロット。
     *   0件が正しい。0件でない時は normalizeInput 側の箱の出入りが変わっている。
     *   黙って捨てず、画面と試験に出す。
     */
    strayAssumedCount: strayAssumedIds.size,
    strayAssumedLots: sorted(strayAssumedIds),
  };
}

/**
 * 帯とカードの文を **同じ内訳から** 作る。
 * 🚨 画面はこの文字列をそのまま出す。画面側で件数を数え直さない。
 *   数え直した瞬間に「帯3件・カード4件」が戻る。
 *
 * @param {object} acc buildArrivalAccounting の戻り値
 * @returns {{band:string|null, card:string|null, bandCounts:object, cardCounts:object}}
 */
export function arrivalSentences(acc) {
  const a = acc && typeof acc === 'object' ? acc : {};
  const assumed = Number(a.assumedCount) || 0;
  const excluded = Number(a.excludedCount) || 0;
  const noAnchor = Number(a.noAnchorCount) || 0;
  const beforeDue = Number(a.assumedBeforeDueCount) || 0;
  const clamped = Number(a.assumedClampedCount) || 0;
  const kindUnknown = Number(a.assumedKindUnknownCount) || 0;
  const days = a.assumeDaysBeforeDue;
  const on = a.assumeOn === true;

  // ── 帯 ──────────────────────────────────────────────────────────────────
  // 🚨🚨 2026-09-04 の直し。前は 38件ぜんぶを「納期の2日前に着く」と言っていたが、
  //   実測では 24件しか2日前に置けておらず、14件は2日前がもう過ぎていて基準時刻に置いていた。
  //   **件数を2つに割って、両方を文に書く**。片方が0件でも「0件」と書く（書かないと嘘に戻る）。
  let band = null;
  if (on) {
    if (assumed > 0 || excluded > 0) {
      const head = assumed > 0
        // ⚠ 基準時刻が「今」か「次の勤務開始」かはこの純関数では分からない(時計を持たない)。
        //   ここでは **計算の基準時刻** と言い、実際の日時は画面(baseNowMs を持つ側)が添える。
        ? `⚠ 入荷日が無い ${assumed}件: 納期の${days}日前に置いた ${beforeDue}件 ／ ${days}日前がもう過ぎているので計算の基準時刻に置いた ${clamped}件。`
          + (kindUnknown > 0 ? `（うち ${kindUnknown}件はどちらか分かりません）` : '')
          + '本当の入荷日を入力すると、そちらで計算し直します。'
        : '⚠ 入荷日を仮に置く設定ですが、仮に置けたロットはありません。';
      // 🚨 残りを必ず言う。言わないと「全部入っている」と読める。
      const tail = excluded > 0
        ? `残る ${excluded}件は仮にも置けないので、この見立てに入れていません。`
        : '';
      band = tail ? `${head}${tail}` : head;
    }
  } else if (excluded > 0) {
    band = `入荷日を仮に置いていません（実データだけで計算しています）。到着の情報が足りない ${excluded}件は、この見立てに入れていません。`;
  }
  if (band && noAnchor > 0) {
    band += `（うち ${noAnchor}件は入荷日も納期も無いので、仮にも置けません）`;
  }

  // ── カード（今日の判断の下の1行）────────────────────────────────────────
  let card = null;
  if (excluded > 0) {
    card = `到着の情報が足りないロット ${excluded}件は、この見立てに入れていません。`;
  }
  if (assumed > 0) {
    const s = `別に ${assumed}件は、仮の入荷日を置いて計算に入れています。`;
    card = card ? `${card}${s}` : s;
  }

  return {
    band,
    card,
    bandCounts: {
      assumed, excluded, noAnchor, beforeDue, clamped, kindUnknown,
    },
    cardCounts: { assumed, excluded },
  };
}

export default buildArrivalAccounting;
