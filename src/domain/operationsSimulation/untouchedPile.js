// =============================================================================
//  untouchedPile.js — 「一時置きに置かれたまま、作業の記録が1件も無いロット」を数える
// -----------------------------------------------------------------------------
//  🚨 なぜ要るか（2026-09-01 清水さん）
//
//    「8月（営業1日）足りない 2,294.8分 … 何言ってるの
//      今の人数で処理できたのに足りないってどういうこと
//      実際も8月終わってるだろ今の人数で」
//
//    実測（2026-08-30 12:11 の控え・本番へは繋いでいません）:
//      製品検査 未完了249件のうち **245件が「作業の記録が1件も無い」**。
//      そのうち 244件 は location='arrival'（＝到着待ちの一時置き）。
//      要る時間の 26,121.0分 ÷ 26,553.0分 = **98.4%** がこの山です。
//      さらにその 244件 の登録時刻は
//        2026-08-21(金) 12:40:11〜12:41:12 の **61.0秒で167件**（1件0.37秒）
//        2026-07-31(金) 18:51:49〜18:52:24 の 34.9秒で66件
//      ＝ 人の手で1件ずつ入れた形ではありません（入荷の一括取込）。
//      最終検査にも **同じ形** があります（zone_shipping に174件・記録0件）。
//
//    シミュレーションはこの山を「これから満額でやる仕事」として全部数えていました。
//    だから「今の人数で終わった8月」に「2.46人日足りない」と出ました。
//
//  🚨🚨 ここが一番大事な線引きです（2026-08-20 清水さん）
//
//    このデータから分かるのは「**アプリに記録が1件も無い**」だけです。
//      ① まだ本当にやっていない
//      ② やったが記録を付けていない
//    この2つは記録の上では**まったく同じ形**で、②を否定する材料はありません。
//
//    だから この山を「終わっている」と決めつけて需要から**引きません**。
//    引かずに **別に数えて、要る時間に対する割合を必ず出します**。
//    そして月の判定は「足ります／足りません」ではなく
//    「**まだ判定していません**（この山が本物か分からないので）」に寄せます。
//    🚨 「実績が無い＝分かりません」であって、やれない・終わっている という意味ではありません。
//
//  ⚠ ここは純関数だけ。Firestore も React も時計(Date.now)も触りません。
// =============================================================================

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));

/**
 * 「一時置き」とみなす場所。
 *
 * ⚠ 2アプリで名前が違います。**判定の形は同じ**にして、名前だけ外から渡します。
 *   製品検査 … lot.location === 'arrival'（到着待ち。mapZoneId はほぼ空）
 *   最終検査 … lot.mapZoneId === 'zone_shipping'（一時置き）
 */
export const HOLDING_LOCATIONS = Object.freeze(['arrival']);
export const HOLDING_ZONE_IDS = Object.freeze(['zone_shipping']);

/**
 * 「作業の記録」とみなす欄（製品検査）。
 *
 * 🚨 **登録した時に入る欄をここへ入れてはいけません。**
 *   入れた瞬間、山のロットが全部「作業した事がある」に化けて、この見張りが死にます。
 *   実測で登録時に入っていた欄: appliedStandard(196件) / steps / unitSerialNumbers /
 *   templateId / dueDate / quantity / entryAt / createdAt / x / y。
 *   ⚠ これらは1つもここに入れません。
 */
export const PRODUCT_WORK_MARK_FIELDS = Object.freeze([
  'workStartTime',        // 作業を始めた時刻
  'firstStartTime',       // 最初に始めた時刻
  'stepTimes',            // 工程ごとの時間
  'totalWorkTime',        // 合計の作業時間
  'measurementResults',   // 測定の結果
  'machineRuns',          // 自動運転の記録
  'workerId',             // 担当者
  'completedAt',          // 完了した時刻
  'completeNotified',     // 完了の連絡
  'interruptions',        // 中断
  'lastPausedAt',         // 一時停止
]);

/**
 * 「作業の記録」とみなす欄（最終検査）。
 * ⚠ 最終検査の担当が同じ形で使えるように、ここに並べて置きます（製品では使いません）。
 */
export const FINAL_WORK_MARK_FIELDS = Object.freeze([
  'workStartTime',
  'firstWorkStartTime',
  'completedAt',
  'completeNotified',
  'packagingPhotos',      // 荷姿写真
  'packagingWorkTime',    // 荷姿の作業時間
  'interruptions',
  'stepMemos',            // 工程メモ
  'lastPausedAt',
  'workerId',
]);

// =============================================================================
//  🚨🚨 2026-09-04 夜 追記（決まり22）— 山を「判定を出さない理由」にするのをやめる
// -----------------------------------------------------------------------------
//  清水さんへの問い:「9月の162ロットが『到着待ちのまま記録0件』なのは実態ですか」
//  清水さんの答え（原文）:
//    「**いつ到着するかわからないからだよ、だから仮のやつ入力してって言ったと思ってるんだけど**」
//
//  → 上に書いた 2026-08-20 の未決（①これからやる ②やったが記録が無い）は **①で確定**。
//    到着待ちに居るのは「入荷日が分からないから」であって、記録漏れではありません。
//
//  🚨 ところが、この山をそのまま「判定できません」の理由に使っていたので、実測で:
//      山を数える側  … 9月の要る時間の 100% が山 → 永久に「まだ判定していません」
//      山を数えない側 … 「この月に納期が来る仕事は 0件です」
//    ＝ **どちらを押しても答えが出ません**。清水さんが頼んだ「仮の入荷日」が、
//      山の規則に打ち消されて効いていませんでした。
//
//  ── 直す形 ───────────────────────────────────────────────────────────────
//  山を2種に分けます。
//    pileArrivalUnknown … **入荷日で説明が付く**山（清水さんの言う普通の姿）→ 数えて判定する
//    pileUnexplained    … 説明が付かない山 → こちらの割合**だけ**で判定を止める
//
//  🚨🚨 「入荷日で説明が付くか」を **ここで新しく判定しません**。
//    normalizeInput.js が既に付けている印を、そのまま読むだけです（決まり18 の担当が作った物）。
//      ・lot.arrivalAssumedKind === 'beforeDue'      … 納期のN日前に仮に置けた
//      ・lot.arrivalAssumedKind === 'clampedToNow'   … N日前が過ぎていて基準時刻に置いた
//      ・unknowns.arrivalUnknown に居る               … 入荷日が1つも無い
//      ・unknowns.arrivalOverdue に居る               … 入荷予定を過ぎたのに現物未確認
//      ・lot.arrivalState === 'scheduled'             … 入荷予定がこれから（まだ着いていない）
//    日付の計算を1つも書きません。**同じ数字を2つの計算から出さない**ためです。
// =============================================================================

/**
 * 「入荷日で説明が付く」理由の名前。**画面にそのまま出せる短い語**を添えてあります。
 * 🚨 ここに無い印は「説明が付かない」＝ pileUnexplained です（黙って説明済みにしない）。
 */
export const PILE_ARRIVAL_WHY = Object.freeze({
  ASSUMED_BEFORE_DUE: 'assumedBeforeDue',
  ASSUMED_CLAMPED: 'assumedClampedToNow',
  ARRIVAL_UNKNOWN: 'arrivalUnknown',
  ARRIVAL_OVERDUE: 'arrivalOverdue',
  ARRIVAL_SCHEDULED: 'arrivalScheduled',
  /**
   * 🚨 入荷は記録済みで、置き場に積まれたまま順番待ち（最終検査の 'entryAtPast' がこれ）。
   *   **入荷日が未定ではありません**。同じ文にまとめると嘘になるので、札も文も別にします。
   */
  ARRIVAL_RECORDED_PARKED: 'arrivalRecordedParked',
});

/** 決まり18 と同じ札。**言葉も2種のままにする**（1つにまとめない）。 */
export const PILE_ARRIVAL_WHY_LABEL = Object.freeze({
  [PILE_ARRIVAL_WHY.ASSUMED_BEFORE_DUE]: '仮(2日前)',
  [PILE_ARRIVAL_WHY.ASSUMED_CLAMPED]: '仮(過ぎ→次の勤務)',
  [PILE_ARRIVAL_WHY.ARRIVAL_UNKNOWN]: '入荷日なし',
  [PILE_ARRIVAL_WHY.ARRIVAL_OVERDUE]: '入荷予定を過ぎて現物未確認',
  [PILE_ARRIVAL_WHY.ARRIVAL_SCHEDULED]: '入荷予定はこれから',
  [PILE_ARRIVAL_WHY.ARRIVAL_RECORDED_PARKED]: '入荷済み・置き場で順番待ち',
});

/**
 * normalizeInput の戻り値から「入荷日で説明が付くロット」の索引を作る。
 *
 * 🚨 判定を書き起こしません。**normalizeInput が付けた印を読むだけ**です。
 *
 * @param {object} args
 * @param {Array} [args.normalizedLots] normalizeInput(...).lots
 * @param {object} [args.unknowns] normalizeInput(...).unknowns
 * @returns {Map<string,string>} lotId → PILE_ARRIVAL_WHY のどれか（居なければ説明が付かない）
 */
export function buildArrivalExplainIndex({ normalizedLots = [], unknowns = null } = {}) {
  const out = new Map();
  const u = isObj(unknowns) ? unknowns : {};
  const idsOf = (v) => (Array.isArray(v) ? v.map((x) => str(isObj(x) ? x.lotId : x)).filter(Boolean) : []);
  // ① まず normalizeInput が1ロットずつ付けた印（決まり18 の2種はここに在る）。
  (Array.isArray(normalizedLots) ? normalizedLots : []).forEach((l) => {
    if (!isObj(l)) return;
    const lotId = str(l.lotId != null ? l.lotId : l.id);
    if (!lotId || out.has(lotId)) return;
    const k = str(l.arrivalAssumedKind);
    if (k === 'beforeDue') { out.set(lotId, PILE_ARRIVAL_WHY.ASSUMED_BEFORE_DUE); return; }
    if (k === 'clampedToNow') { out.set(lotId, PILE_ARRIVAL_WHY.ASSUMED_CLAMPED); return; }
    if (str(l.arrivalState) === 'scheduled') out.set(lotId, PILE_ARRIVAL_WHY.ARRIVAL_SCHEDULED);
  });
  // ② 仮に置いていない時（仮の入荷日を切っている時）の受け皿。上書きはしない。
  idsOf(u.arrivalUnknown).forEach((id) => { if (!out.has(id)) out.set(id, PILE_ARRIVAL_WHY.ARRIVAL_UNKNOWN); });
  idsOf(u.arrivalOverdue).forEach((id) => { if (!out.has(id)) out.set(id, PILE_ARRIVAL_WHY.ARRIVAL_OVERDUE); });
  return out;
}

/** 中身がある（＝記録が付いている）か。0 と空配列と空の表と空文字は「無い」。 */
function hasContent(v) {
  if (v == null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'boolean') return v === true;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return String(v).trim() !== '';
}

/**
 * ロット1つ分を見る。
 *
 * @param {object} lot 生のロット（App.jsx が持っている形そのまま）
 * @param {string[]} fields 作業の記録とみなす欄
 * @returns {{untouched:boolean, marks:string[]}} marks は見つかった記録の欄の名前
 */
export function readWorkMarks(lot, fields = PRODUCT_WORK_MARK_FIELDS) {
  const marks = [];
  if (!isObj(lot)) return { untouched: true, marks };
  (Array.isArray(fields) ? fields : []).forEach((f) => {
    if (hasContent(lot[f])) marks.push(String(f));
  });
  // tasks は「1件でも欄があれば記録あり」。
  // ⚠ 中身が空の入れ物（{}）は記録ではありません。
  const tasks = isObj(lot.tasks) ? lot.tasks : null;
  if (tasks && Object.keys(tasks).length > 0) marks.push('tasks');
  return { untouched: marks.length === 0, marks };
}

/**
 * 一時置きの山を数える。
 *
 * 🚨 「未完了かどうか」はここで決めません。渡された物をそのまま見ます。
 *   完了したロットまで渡すと山が水増しされるので、**未完了のロットだけ**渡してください
 *   （normalizeInput が使っている isOpenLot と同じ選び方）。
 *
 * @param {object} args
 * @param {Array} args.lots 生のロットの配列
 * @param {string[]} [args.workMarkFields] 作業の記録とみなす欄。既定は製品検査の一式
 * @param {string[]} [args.holdingLocations] 一時置きとみなす location
 * @param {string[]} [args.holdingZoneIds] 一時置きとみなす mapZoneId
 * @returns {object}
 */
export function buildUntouchedPile({
  lots = [],
  workMarkFields = PRODUCT_WORK_MARK_FIELDS,
  holdingLocations = HOLDING_LOCATIONS,
  holdingZoneIds = HOLDING_ZONE_IDS,
  /**
   * 🚨 決まり22。buildArrivalExplainIndex の戻り値（lotId → 説明の理由）。
   *   渡さなければ **山は1種のまま**（前と同じ数え方。後ろ向きに壊さない）。
   */
  arrivalExplainByLot = null,
} = {}) {
  const locSet = new Set((Array.isArray(holdingLocations) ? holdingLocations : []).map(str));
  const zoneSet = new Set((Array.isArray(holdingZoneIds) ? holdingZoneIds : []).map(str));
  const whyOf = (lotId) => {
    if (arrivalExplainByLot instanceof Map) return str(arrivalExplainByLot.get(lotId)) || '';
    if (isObj(arrivalExplainByLot)) return str(arrivalExplainByLot[lotId]) || '';
    return '';
  };
  const explainProvided = arrivalExplainByLot instanceof Map || isObj(arrivalExplainByLot);

  const byLot = new Map();
  let untouchedLotCount = 0;
  let holdingLotCount = 0;
  let pileLotCount = 0;
  let lotCount = 0;
  let pileArrivalUnknownLotCount = 0;
  let pileUnexplainedLotCount = 0;
  const whyCounts = {};

  (Array.isArray(lots) ? lots : []).forEach((lot) => {
    if (!isObj(lot)) return;
    const lotId = str(lot.lotId != null ? lot.lotId : (lot.id != null ? lot.id : lot.__id));
    if (!lotId) return;
    lotCount += 1;
    const { untouched, marks } = readWorkMarks(lot, workMarkFields);
    const location = str(lot.location);
    const zoneId = str(lot.mapZoneId);
    const holding = locSet.has(location) || zoneSet.has(zoneId);
    // 🚨 「山」＝ **一時置き かつ 記録0件** の両方。片方だけでは山と呼びません。
    const pile = untouched && holding;
    if (untouched) untouchedLotCount += 1;
    if (holding) holdingLotCount += 1;
    if (pile) pileLotCount += 1;
    // 🚨 決まり22。山の中を「入荷日で説明が付く／付かない」の2つに分ける。
    //   索引が渡っていない時は分けない（arrivalWhy='' / arrivalExplained=null）。
    const arrivalWhy = pile && explainProvided ? whyOf(lotId) : '';
    const arrivalExplained = (pile && explainProvided) ? (arrivalWhy !== '') : null;
    if (arrivalExplained === true) {
      pileArrivalUnknownLotCount += 1;
      whyCounts[arrivalWhy] = (whyCounts[arrivalWhy] || 0) + 1;
    } else if (arrivalExplained === false) {
      pileUnexplainedLotCount += 1;
    }
    // 同じ lotId が2回来たら、後の物で上書きしない（先に見た物を残す）。
    if (!byLot.has(lotId)) {
      byLot.set(lotId, {
        lotId, untouched, holding, pile, location, zoneId, marks,
        /** 🚨 決まり22。true=入荷日で説明が付く / false=付かない / null=索引が渡っていない */
        arrivalExplained,
        /** PILE_ARRIVAL_WHY のどれか。空文字は「説明が付かない」または索引が無い */
        arrivalWhy,
      });
    }
  });

  return {
    byLot,
    lotCount,
    /** 作業の記録が1件も無いロット（場所は問わない） */
    untouchedLotCount,
    /** 一時置きに居るロット（記録の有無は問わない） */
    holdingLotCount,
    /** 🚨 一時置き かつ 記録0件 ＝ この見張りが数える「山」 */
    pileLotCount,
    pileLotIds: [...byLot.values()].filter((x) => x.pile).map((x) => x.lotId).sort(),
    /**
     * 🚨 決まり22。山のうち **入荷日で説明が付く**分（清水さんの言う普通の姿）。
     *   ここは判定を止める理由にしません。**数えて判定します**。
     */
    pileArrivalUnknownLotCount,
    pileArrivalUnknownLotIds: [...byLot.values()].filter((x) => x.arrivalExplained === true).map((x) => x.lotId).sort(),
    /** 🚨 決まり22。説明が付かない山。**判定を止めるのはこちらの割合だけ**。 */
    pileUnexplainedLotCount,
    pileUnexplainedLotIds: [...byLot.values()].filter((x) => x.arrivalExplained === false).map((x) => x.lotId).sort(),
    /** 理由ごとの件数（決まり18 の2種をそのまま残す。1つに混ぜない） */
    pileArrivalWhyCounts: { ...whyCounts },
    /** 索引が渡ったか。false の時は山を1種のまま扱う（前と同じ） */
    arrivalExplainProvided: explainProvided,
    /** 判定に使った欄の名前。画面の「根拠」へそのまま出せる */
    workMarkFields: [...(Array.isArray(workMarkFields) ? workMarkFields : [])],
    holdingLocations: [...locSet],
    holdingZoneIds: [...zoneSet],
  };
}

/**
 * 画面へそのまま出せる1文。
 * 🚨 「終わっている」とも「これからやる」とも書きません。**分かりません** と書きます。
 */
export function pileQuestionSentence(pileLotCount, holdingWord = '一時置き') {
  const n = Math.max(0, Math.trunc(Number(pileLotCount) || 0));
  if (n === 0) return '';
  return `${holdingWord}に ${n}ロットが、作業の記録が1件も無いまま並んでいます。`
    + 'これから検査する物か、検査は済んでいて記録だけ付いていない物か、この記録からは分かりません。';
}

/**
 * 🚨 決まり22-3。判定の言葉に**必ず添える**1文（畳んでよい・消してはいけない）。
 *
 *   「この月の仕事 ◯件のうち ◯件は入荷日が未定です。
 *     納期の2日前に着くと仮に置いて数えています（2日前に置いた◯件／2日前が過ぎていて基準時刻に置いた◯件）」
 *
 * 🚨 2種の内訳は **決まり18 と同じ札** をそのまま使います。ここで数え直しません。
 *
 * @param {object} args
 * @param {number} args.monthLotCount その月の仕事のロット数
 * @param {number} args.arrivalUnknownLotCount そのうち入荷日で説明が付く（＝未定の）ロット数
 * @param {object} [args.whyCounts] PILE_ARRIVAL_WHY ごとの件数
 * @param {number|null} [args.assumeDaysBeforeDue] 仮に置く日数（切っていれば null）
 * @returns {string} 出す物が無ければ空文字
 */
export function pileArrivalSentence({
  monthLotCount = 0, arrivalUnknownLotCount = 0, whyCounts = null, assumeDaysBeforeDue = null,
} = {}) {
  const total = Math.max(0, Math.trunc(Number(monthLotCount) || 0));
  const unknown = Math.max(0, Math.trunc(Number(arrivalUnknownLotCount) || 0));
  if (unknown <= 0) return '';
  const w = isObj(whyCounts) ? whyCounts : {};
  const n = (k) => Math.max(0, Math.trunc(Number(w[k]) || 0));
  const before = n(PILE_ARRIVAL_WHY.ASSUMED_BEFORE_DUE);
  const clamped = n(PILE_ARRIVAL_WHY.ASSUMED_CLAMPED);
  const noDate = n(PILE_ARRIVAL_WHY.ARRIVAL_UNKNOWN);
  const overdue = n(PILE_ARRIVAL_WHY.ARRIVAL_OVERDUE);
  const scheduled = n(PILE_ARRIVAL_WHY.ARRIVAL_SCHEDULED);
  const parked = n(PILE_ARRIVAL_WHY.ARRIVAL_RECORDED_PARKED);
  const days = Number(assumeDaysBeforeDue);
  const dayWord = Number.isFinite(days) && days > 0 ? `${Math.trunc(days)}日前` : '';
  const parts = [];
  if (dayWord && (before > 0 || clamped > 0)) {
    parts.push(`納期の${dayWord}に置いた ${before}件`);
    parts.push(`${dayWord}が過ぎていて基準時刻に置いた ${clamped}件`);
  }
  if (noDate > 0) parts.push(`入荷日が1つも無い ${noDate}件`);
  if (overdue > 0) parts.push(`入荷予定を過ぎたのに現物が確かめられていない ${overdue}件`);
  if (scheduled > 0) parts.push(`入荷予定がこれから先の ${scheduled}件`);
  // 🚨 「入荷が記録済みで、置き場で順番待ち」は **入荷日が未定ではありません**。
  //   同じ文にまとめると嘘になるので、別の1文にします（2026-08-22「混ぜるな」）。
  const undecided = unknown - parked;
  const parkedSentence = parked > 0
    ? `${parked}件は入荷が記録済みで、置き場に積まれたまま まだ着手していません。` : '';
  if (undecided <= 0) {
    return parkedSentence ? `この月の仕事 ${total}件のうち ${parkedSentence}` : '';
  }
  const head = `この月の仕事 ${total}件のうち ${undecided}件は入荷日が未定です。`;
  const body = dayWord
    ? `納期の${dayWord}に着くと仮に置いて数えています`
    : '入荷日を仮に置く設定を切っているので、この分は手が付かない物として数えています';
  const main = parts.length > 0 ? `${head}${body}（${parts.join('／')}）。` : `${head}${body}。`;
  return parkedSentence ? `${main}ほかに ${parkedSentence}` : main;
}
