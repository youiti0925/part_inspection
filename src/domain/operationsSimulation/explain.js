// ============================================================================
// 🔍 explain.js — 「守れる/守れない」の先。原因と、その原因に効く手を組で返す
// ----------------------------------------------------------------------------
// 出典: 是正指示書 5.7(原因分類) / 5.8(6つのシナリオ) / 6.2(最上部の4つ) と
//       CONTRACT.md の explain.js の節。
//
// 🚨 「遅れます」で終わらせない(指示書5.7)。
//   出すのは必ず【原因】と【その原因に効く手】の組。
//   原因を分けるのは、対策が原因ごとに全く違うから:
//     総時間不足 → 応援・残業・納期調整・平準化
//     技能の偏り → OJT・教材・正式な認定・技能者の応援
//     設備      → 日程の入れ替え・別の設備・順序変更
//     入力不足  → 前工程へ確認・仮の条件を入れて試す
//     時間不明  → 計測・検査表の整備
//     配置      → 配る順の見直し
//
// 🚨 決め事(CONTRACT.md 0章)
//   - React / Firebase を import しない。純関数だけ。
//   - 関数の中で現在時刻や乱数を読まない(この中では日時を1つも作っていない)。
//     → 同じ入力なら毎回同じ説明(S23)。
//   - 分からない物を数字にしない。測っていない対策の効果は deltaLate:null で返す。
//
// ----------------------------------------------------------------------------
// 【原因の分け方】(指示書5.7 の表そのまま)
//   総時間不足 : 全員がどの工程も持てる仮定(mode:'all')でも越える
//   技能の偏り : その仮定なら守れるのに、記録のある人だけだと越える
//   設備      : 人は空いているのに、要る設備がふさがって待った
//   入力不足   : 到着や納期が分からず、判定の材料が足りない
//   時間不明   : 目標の作業時間が入っていない
//   配置      : 同じ人・設備のままでも、配る順を変えれば遅れが減る
//
// 【突破の時刻は2つある】(是正指示書10章 S1-E ④「欠員時に突破日が変わる」)
//   breachAt         … simulate が出した「最初に線を越えた時刻」。
//                      **すでに予定日を過ぎたロット** も含む。その1件で決まってしまうと、
//                      人を減らそうが増やそうが値が1ミリ秒も動かない。
//   forecastBreachAt … **この先** 越える物(alreadyPastDue でない late)の中で一番早い時刻。
//                      欠員を入れると早まる／新しく出る。シナリオを比べるのはこちら。
//   🚨 どちらか一方に寄せない。breachAt を消すと「今日すでに過ぎている」が見えなくなり、
//     forecastBreachAt を足さないと ④ が永久に落ちる。返り値のキー名で必ず区別する事。
//
// 【手が付かない仕事】(是正指示書10章 S1-E ④ の実体)
//   欠員の効きめは「遅れ件数」ではなく **置けない仕事の数** に出る。
//   unresolvedCount / unresolvedByReason / unresolvedLots をそのまま返す。
//
// 【入力】explainResult({ base, allSkills, scenarios, normalized })
//   base      … 既定の見方(履歴からの暫定候補)で回した simulateOperations の結果
//   allSkills … mode:'all'(全員がどの工程も持てる仮定)で回した結果。指示書4章-1
//   scenarios … 比べたい他の結果。[{ id, label, kind, result }]
//               kind:'placement' を付けた物だけ「配置の問題」の判定に使う
//               (同じ人・同じ設備で、配る順だけを変えた結果、という意味)
//   normalized… normalizeInput の戻り値。分からない物の一覧をここから読む
// ============================================================================

import { UNRESOLVED_REASON, IDLE_REASON } from './simulate.js';
// 🚨 2026-09-01 矛盾Aの直し。効き目のものさし(危険なロット)と『一番効く手』の選び方は
//   このファイルに書かない。atRisk.js / remedyRank.js の **ただ1か所** を呼ぶ。
//   改善・教育タブ(scenarios.js rankImprovements)も同じ物を呼ぶので、
//   同じ顔ぶれなら同じ手・同じ数が出る。
import { atRiskCount } from './atRisk.js';
import { rankRemedies, REMEDY_MEASURE, REMEDY_ASSUMPTION_NOTE } from './remedyRank.js';
// 🚨 手の**鍵**も2つの経路で同じ物を使う。片方が名札(label)・片方がID だと、
//   効き目が同点の時に並びが割れて、2つの画面が違う手を指す(実際に割れた)。
//   ⚠ scenarios.js は explain.js を読まないので、この向きの import で輪にならない。
import { SCENARIO_ID } from './scenarios.js';

export const CAUSE = Object.freeze({
  TOTAL_TIME: 'total_time',
  SKILL: 'skill',
  EQUIPMENT: 'equipment',
  INPUT_MISSING: 'input_missing',
  DURATION_UNKNOWN: 'duration_unknown',
  PLACEMENT: 'placement',
});

/** 原因ごとの「主な対策」。指示書5.7 の表の右の列。 */
export const REMEDY_HINT = Object.freeze({
  total_time: { label: '応援・残業・納期の調整・仕事量の平準化', sentence: '人か時間を増やすか、納期をずらすか、山を平らにする。この4つのどれかでしか埋まりません。' },
  skill: { label: 'OJT・教材・正式な認定・技能者の応援', sentence: '1つの工程に人が寄っています。誰か1人が持てるようになるだけで山が割れます。' },
  equipment: { label: '設備の日程変更・別の設備・順序の入れ替え', sentence: '人ではなく設備が先に埋まっています。順番を入れ替えると空きが使えます。' },
  input_missing: { label: '前の工程へ到着と納期を確かめる／仮の条件で試す', sentence: '材料が足りないので、この分は守れるかどうかを言えません。仮の日付を入れて試せます。' },
  duration_unknown: { label: '目標時間の計測・検査表の整備', sentence: '目標の時間が無い工程は、時間に数えていません。1回計るだけで結果が変わります。' },
  placement: { label: '配る順の見直し', sentence: '同じ人と設備のままで、着手の順を変えるだけで遅れが減ります。' },
});

/** 指示書5.7 の表の並び。画面はこの順で出す。 */
const CAUSE_ORDER = Object.freeze([
  CAUSE.TOTAL_TIME, CAUSE.SKILL, CAUSE.EQUIPMENT,
  CAUSE.INPUT_MISSING, CAUSE.DURATION_UNKNOWN, CAUSE.PLACEMENT,
]);

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const finite = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** ⚠ localeCompare を使わない(端末の言語データで並びが変わると S23 が崩れる)。 */
const cmpId = (a, b) => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
};
const uniqSorted = (list) => [...new Set(list.filter((x) => x != null && x !== ''))].sort(cmpId);

// ── 結果の読み取り ───────────────────────────────────────────────────────────

/** 線を越えたロット。 */
const lateLotsOf = (result) => arr(result?.lotResults).filter((r) => r && r.late === true);

/**
 * 「確かに間に合わなかった」ロット。
 * 🚨 手が付かなかった仕事(時間が分からない・候補が居ない等)を抱えたロットは外す。
 *   それは「時間が足りない」のではなく「判定の材料が無い」。
 *   混ぜると、目標時間が1件入っていないだけで「総時間不足」と言ってしまう。
 */
//   🚨 2026-08-22: blocked は **真偽値ではなく理由の文字列** になった(simulate.js)。
//   `!== true` のままだと1件も外れず、目標時間が1件無いだけで「総時間不足」と言ってしまう。
const provenLateOf = (result) => lateLotsOf(result).filter((r) => r.blocked == null && r.judgeable !== false);

/** 越えた物と、手が付かず止まった物。どちらも「このままでは片付かない」。 */
const troubledOf = (result) => arr(result?.lotResults).filter((r) => r && (r.late === true || r.blocked != null));

const lotIdsOf = (rows) => uniqSorted(rows.map((r) => r.lotId));

/**
 * 🚨 2026-08-23 削除: crossingMsOf（finishMs を優先して「線を越える時刻」を作っていた関数）。
 *   これを forecastBreachAt に使っていたので、画面の「最初に越える時刻」が
 *   **納期時刻ではなく終わる見込みの時刻**になっていた。
 *   工数を悲観側(P90)に振るほど値が後ろへ動き、画面は「良くなった」と色を付けていた。
 *   いまは forecastBreachAt を **遅れるロットの dueLineMs の最小値** で作る（下を見る事）。
 *   ⚠ 「いつ終わるか」が要る所は r.finishMs をその場で読む。名前で意味をぼかさない。
 */

/**
 * jobId からロットを割り出す。jobId は `${lotId}#${工程}#${台}` (buildJobs.js)。
 * ⚠ 分からなければ jobId をそのまま返す。無理に切って別のロットの名前を作らない。
 */
function lotIdOfJob(jobId, knownLotIds) {
  const s = String(jobId ?? '');
  const at = s.indexOf('#');
  if (at > 0) {
    const head = s.slice(0, at);
    if (!knownLotIds || knownLotIds.has(head)) return head;
  }
  return s;
}

// ============================================================================
// 本体
// ============================================================================

/**
 * @param {object} args { base, allSkills, scenarios, normalized }
 * @returns {{verdict:string, breachAt:number|null, forecastBreachAt:number|null,
 *            lateLots:string[], maxLateMs:number|null,
 *            unresolvedCount:number, unresolvedByReason:object, unresolvedLots:string[],
 *            causes:Array, remedies:Array}}
 *   lateLots         … 線を越えたロットの lotId の一覧(画面は件数と一覧の両方に使える)
 *   breachAt         … すでに予定日を過ぎた物も含む「最初に線を越えた時刻」(今までの意味)
 *   forecastBreachAt … この先 越える物だけで見た、一番早く線を越える時刻
 *   unresolvedCount  … 手が付かなかった仕事の件数(base.unresolved.length)
 *   unresolvedByReason … 理由ごとの件数。合計は unresolvedCount と一致する
 *   unresolvedLots   … 手が付かない仕事を持つ lotId の一覧
 */
export function explainResult({
  base, allSkills, scenarios, normalized,
  // 🚨 仕様書5.8 / T014 / T019: 同じ土俵でないシナリオを「測定済みの効果」に混ぜない。
  //   渡されなければ土俵の照合をしない(今まで通り)。渡されたら **一致した物だけ** を数字にする。
  inputFingerprint = null, baseNow = null,
} = {}) {
  if (!isObj(base)) {
    throw new Error('explainResult: base（simulateOperations の結果）を渡してください');
  }
  const all = isObj(allSkills) ? allSkills : null;
  const list = arr(scenarios).filter((s) => isObj(s) && isObj(s.result));
  const unknowns = isObj(normalized?.unknowns) ? normalized.unknowns : {};
  const knownLotIds = new Set(arr(normalized?.lots).map((l) => l?.lotId).filter(Boolean));

  const baseLate = lateLotsOf(base);
  // 🚨🚨 画面はこの2つを **必ず分けて** 出す事。混ぜたのが 2026-08-22 の是正の核心。
  //   alreadyPastDue = 今日の事実(日を進めても増えない) / forecastLate = この見立ての結果
  const alreadyPastDueRows = arr(base.lotResults).filter((r) => r && r.alreadyPastDue === true);
  const forecastLateRows = baseLate.filter((r) => r.alreadyPastDue !== true);
  const unjudgeableRows = arr(base.lotResults).filter((r) => r && r.judgeable === false);
  const baseProven = provenLateOf(base);
  const baseTroubled = troubledOf(base);
  const baseUnresolved = arr(base.unresolved);

  const maxLateMs = baseLate.reduce((acc, r) => {
    const v = finite(r.lateMs);
    if (v == null) return acc;
    return (acc == null || v > acc) ? v : acc;
  }, null);

  // 🚨🚨 ④「欠員時に突破日が変わる」はここで決まる。
  //   base.breachAt は すでに予定日を過ぎた1件で埋まってしまい、人を動かしても不動になる。
  //   forecastBreachAt は **この先** 越える物だけで見るので、欠員を入れると早まる／新しく出る。
  // 🚨🚨 2026-08-23 是正（清水さんの指摘）:
  //   ここは以前 crossingMsOf（finishMs を優先＝**終わる見込みの時刻**）を使っていた。
  //   だから画面の「最初に越える時刻」は納期時刻ではなく完了予測時刻になっていた。
  //   実害: P75 8/25 08:50 → P90 09:30。工数を悲観側(P90)に振るほど終わりが遅くなるので
  //     値が後ろへ動き、画面は「後ろへ動いた＝良くなった」と色を付けていた。
  //     裏では最大遅れが 15.8h→16.5h と **悪化** している。**逆に見せていた。**
  //   → 「最初に守れなくなるロットの **納期時刻**」に統一する。
  //     こうすると P75 も P90 も 2026/8/24 17:00 で一致し、逆転が消える。
  //   ⚠ simulate.js:1071 の breachAt と scenarios.js:179 の forecastBreachAt は
  //     元から dueLineMs で作っていた。**同じ名前で式が2つ**あったのを1つにそろえた。
  const forecastBreachAt = forecastLateRows.reduce((acc, r) => {
    const t = finite(r && r.dueLineMs);
    if (t == null) return acc;              // 納期線が分からない物は数えない（時刻を作らない）
    return (acc == null || t < acc) ? t : acc;
  }, null);

  // 🚨 欠員の効きめは遅れ件数ではなく「置けない仕事」に出る(実測: 10件→31件で遅れ件数は不動)。
  //   画面がシナリオを比べられるように、そのまま数えて返す。
  const unresolvedCount = baseUnresolved.length;
  const reasonCounts = new Map();
  for (const u of baseUnresolved) {
    const reason = String(u?.reason ?? '').trim();
    if (!reason) continue;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
  // ⚠ キーの並びを固定する(S23 同じ入力→同じ結果。JSON にした時の並びまで含めて同じにする)。
  const unresolvedByReason = {};
  for (const reason of [...reasonCounts.keys()].sort(cmpId)) unresolvedByReason[reason] = reasonCounts.get(reason);
  const unresolvedLots = uniqSorted(baseUnresolved.map((u) => lotIdOfJob(u?.jobId, knownLotIds)));

  // ── 分からない物 ─────────────────────────────────────────────────────────
  const dueUnknown = arr(unknowns.dueUnknown);
  const arrivalUnknown = arr(unknowns.arrivalUnknown);
  const templateMissing = arr(unknowns.templateMissing);
  const durationUnknown = arr(unknowns.durationUnknown);
  const unresolvedBy = (reason) => baseUnresolved.filter((u) => u && u.reason === reason);
  const durationBlocked = unresolvedBy(UNRESOLVED_REASON.DURATION_UNKNOWN);
  const arrivalBlocked = unresolvedBy(UNRESOLVED_REASON.ARRIVAL_UNKNOWN);
  const noCandidate = unresolvedBy(UNRESOLVED_REASON.NO_CANDIDATE);
  // 👥 2026-09-16 「ずっと休み」と「ずっと◯◯の応援」は同じ側(候補は居るが この期間は居ない)
  const candidatesAway = [
    ...unresolvedBy(UNRESOLVED_REASON.ALL_CANDIDATES_AWAY),
    ...unresolvedBy(UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_PRODUCT),
    ...unresolvedBy(UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_FINAL),
  ];

  const inputMissingCount = dueUnknown.length + arrivalUnknown.length + templateMissing.length + arrivalBlocked.length;
  const durationMissingCount = durationUnknown.length + durationBlocked.length;
  // 🚨 設備の設定が0件(unknowns.equipment==='unset')なのは、本番のいまの普通の状態。
  //    これを「入力不足」に数えると、毎回「判定できません」になって画面が役に立たない。
  //    設備は「待ちが実際に起きた時」だけ原因にする(下の EQUIPMENT)。

  // ── 判定 ─────────────────────────────────────────────────────────────────
  // breach   … 確かに越えたロットがある
  // unknown  … 越えてはいないが、材料が足りず言い切れない物がある
  // safe     … 全部片付く
  const verdict = baseProven.length > 0
    ? 'breach'
    : ((baseTroubled.length > 0 || baseUnresolved.length > 0 || inputMissingCount > 0 || durationMissingCount > 0)
      ? 'unknown'
      : 'safe');

  // ── 原因 ─────────────────────────────────────────────────────────────────
  const causes = [];
  const push = (cause, lotIds, evidence, sentence) => causes.push({ cause, lotIds, evidence, sentence });

  // 1. 総時間不足 — 全員がどの工程も持てる仮定でも越える
  //   🚨 「すでに予定日を過ぎている」物を混ぜない。それは今日の事実であって、
  //   これから時間が足りるかどうかの話ではない。混ぜると数が倍近くに見える(実測 38→109)。
  const allProvenAll = all ? provenLateOf(all) : [];
  const allProven = allProvenAll.filter((r) => r.alreadyPastDue !== true);
  const allPastDue = allProvenAll.length - allProven.length;
  if (allProven.length > 0) {
    push(
      CAUSE.TOTAL_TIME,
      lotIdsOf(allProven),
      { lateLotCount: allProven.length, alreadyPastDueCount: allPastDue, breachAt: finite(all.breachAt), comparedWith: 'all' },
      `全員がどの工程も持てる仮定でも ${allProven.length}件が予定日に間に合いません。この期間に使える時間より仕事が多い状態です。`,
    );
  }

  // 2. 技能の偏り — その仮定なら守れるのに、記録のある人だけだと越える
  const allTroubled = all ? troubledOf(all).filter((r) => r.alreadyPastDue !== true) : [];
  // 🚨 2026-08-23 是正(T018): ここは以前 `allTroubled.length === 0` だった。
  //   つまり「全員万能にすると **1件も残らない**」時しか技能の偏りと言わなかった。
  //   仕様書5.10 は「通常より全員万能の危険件数または未配置が **減る**」であって、
  //   ゼロになる事ではない。3件→1件の様に**減っても残る**場合、
  //   旧条件だと「仕事量超過」だけが出て、**原因が1つに絞られてしまう**(5.10 が禁じている)。
  const baseTroubledFuture = baseTroubled.filter((r) => r.alreadyPastDue !== true);
  const skillByComparison = !!all && baseTroubledFuture.length > allTroubled.length;
  const skillByUnresolved = noCandidate.length > 0 || candidatesAway.length > 0;
  if (skillByComparison || skillByUnresolved) {
    const ids = new Set(lotIdsOf(baseTroubled.filter((r) => r.alreadyPastDue !== true)));
    for (const u of [...noCandidate, ...candidatesAway]) ids.add(lotIdOfJob(u.jobId, knownLotIds));
    push(
      CAUSE.SKILL,
      uniqSorted([...ids]),
      {
        lateLotCount: baseTroubled.length,
        allSkillsLateLotCount: allTroubled.length,
        noCandidateJobs: noCandidate.length,
        candidatesAwayJobs: candidatesAway.length,
        /** 🚨 全員万能にして減る件数。これが「人の偏り」で説明できる分 */
        reducedByAllSkills: all ? Math.max(0, baseTroubledFuture.length - allTroubled.length) : null,
      },
      skillByComparison
        ? (allTroubled.length === 0
          ? `全員が持てる仮定なら守れますが、記録のある人だけで回すと ${baseTroubledFuture.length}件が間に合いません。特定の工程に人が寄っています。`
          : `全員が持てる仮定にすると ${baseTroubledFuture.length}件 → ${allTroubled.length}件 まで減ります（${baseTroubledFuture.length - allTroubled.length}件ぶんは人の偏り）。残る ${allTroubled.length}件は持てる人を増やしても消えません。`)
        : `やった記録が見当たらない工程が ${noCandidate.length + candidatesAway.length}件ぶんの作業にあります（ロット ${uniqSorted([...ids]).length}件）。記録が無いだけで、やれないという意味ではありません。`,
    );
  }

  // 3. 設備 — 人は空いたのに、要る設備がふさがっていた
  const equipmentWaits = arr(base.idleLog).filter((e) => e && e.reason === IDLE_REASON.EQUIPMENT);
  if (equipmentWaits.length > 0) {
    const waitJobs = arr(base.audit).filter((a) => a && a.kind === 'wait-equipment');
    const waitedMs = equipmentWaits.reduce((s, e) => s + Math.max(0, (finite(e.toMs) ?? 0) - (finite(e.fromMs) ?? 0)), 0);
    push(
      CAUSE.EQUIPMENT,
      uniqSorted(waitJobs.map((a) => a.lotId)),
      { waitCount: equipmentWaits.length, waitedMs, jobCount: waitJobs.length },
      `手が空いているのに設備がふさがって待った時間があります（${equipmentWaits.length}件）。`,
    );
  }

  // 4. 到着・納期が分からない — 判定の材料が足りない
  if (inputMissingCount > 0) {
    const ids = new Set([...dueUnknown, ...arrivalUnknown].map((x) => (typeof x === 'string' ? x : x?.lotId)));
    for (const u of arrivalBlocked) ids.add(lotIdOfJob(u.jobId, knownLotIds));
    push(
      CAUSE.INPUT_MISSING,
      uniqSorted([...ids]),
      {
        dueUnknown: dueUnknown.length,
        arrivalUnknown: arrivalUnknown.length + arrivalBlocked.length,
        templateMissing: templateMissing.length,
      },
      `到着か納期が分からないロットが ${inputMissingCount}件あります。この分は守れるかどうかを言えません。`,
    );
  }

  // 5. 目標の作業時間が無い
  if (durationMissingCount > 0) {
    const ids = new Set(durationUnknown.map((x) => (typeof x === 'string' ? x : x?.lotId)));
    for (const u of durationBlocked) ids.add(lotIdOfJob(u.jobId, knownLotIds));
    push(
      CAUSE.DURATION_UNKNOWN,
      uniqSorted([...ids]),
      { steps: durationUnknown.length, jobs: durationBlocked.length },
      `目標の作業時間が入っていない工程が ${durationUnknown.length || durationBlocked.length}件あります。その分は時間に数えていません。`,
    );
  }

  // 6. 配置 — 同じ人・同じ設備で、配る順を変えたら遅れが減った
  const placements = list.filter((s) => String(s.kind ?? '') === 'placement');
  const bestPlacement = placements.reduce((best, s) => {
    const n = lateLotsOf(s.result).length;
    return (best == null || n < best.count) ? { s, count: n } : best;
  }, null);
  if (bestPlacement && bestPlacement.count < baseLate.length) {
    const saved = baseLate.length - bestPlacement.count;
    push(
      CAUSE.PLACEMENT,
      lotIdsOf(baseLate),
      { baseLateLotCount: baseLate.length, bestLateLotCount: bestPlacement.count, scenario: labelOf(bestPlacement.s) },
      `同じ人と設備のままでも、配る順を変えると遅れが ${saved}件減ります。`,
    );
  }

  causes.sort((a, b) => CAUSE_ORDER.indexOf(a.cause) - CAUSE_ORDER.indexOf(b.cause));

  const remedyPick = buildRemedies({ base, all, list, causes, inputFingerprint, baseNow });

  return {
    alreadyPastDueLots: lotIdsOf(alreadyPastDueRows),
    forecastLateLots: lotIdsOf(forecastLateRows),
    unjudgeableLots: lotIdsOf(unjudgeableRows),
    verdict,
    // 🚨 名前で区別する。breachAt = すでに過ぎた物も含む最初 / forecastBreachAt = この先の最初。
    breachAt: finite(base.breachAt),
    forecastBreachAt,
    lateLots: baseLate.map((r) => r.lotId),
    maxLateMs,
    unresolvedCount,
    unresolvedByReason,
    unresolvedLots,
    causes,
    // 🚨 2026-09-01 矛盾Aの直し。remedies は今まで通り配列のまま(古い読み手を壊さない)。
    //   『一番効く手』は remedies[0] を画面が自分で選ぶのをやめ、**remedyPick** を読む。
    //   remedyPick は改善・教育タブ(rankImprovements)と同じ関数・同じものさし・同じ規則。
    remedies: remedyPick.list,
    remedyPick: {
      best: remedyPick.best,
      ceiling: remedyPick.ceiling,
      measure: remedyPick.measure,
      measureLabel: remedyPick.measureLabel,
    },
  };
}

export default explainResult;

const labelOf = (s) => {
  const t = String(s?.label ?? s?.id ?? '').trim();
  return t || '別の条件';
};

/**
 * 対策。指示書5.8 の6シナリオの差分で出す。
 *
 * effect = base の危険なロット数 − そのシナリオの危険なロット数。
 *   正なら「その手で救えるロット数」。指示書5.8-6「この人を育てたら何ロット救えるか」。
 * 🚨 測っていない手は effect:null。0 と書くと「効かない事を確かめた」に読める。
 *
 * ⚠ 2026-09-01: 引数 baseLateCount は使わなくなった（ものさしを「遅れるロット」から
 *   「危険なロット」へ寄せた為。理由は atRisk.js の頭）。呼ぶ側を今すぐ直さなくて
 *   良い様に受け口だけ残していたが、使っていない引数は誤解の元なので外した。
 */
function buildRemedies({ base, all, list, causes, inputFingerprint = null, baseNow = null }) {
  const measured = [];
  const seen = new Set();
  // ⚠ 同じ結果を2回出さない。呼ぶ側が allSkills と scenarios の両方に同じ物を入れる事が
  //   あり(画面は6シナリオを並べて渡す)、名前だけで見ていると同じ手が2行に並ぶ。
  const seenResults = new Set();

  // 🚨🚨 2026-09-01 矛盾Aの直し。ものさしを **危険なロット** に寄せた。
  //   直す前は `late === true` の件数で引き算していた。あの数には
  //   「すでに納期を過ぎたロット」が入っている。あれは今日の事実で、どんな手を打っても
  //   1件も減らない。入れたままだと、改善・教育タブ(危険なロットで見ている)と
  //   **同じ『一番効く手』が違う数を持つ**。
  //   数え方は atRisk.js ただ1本(scenarios.js の toScenarioMetrics も同じ物を呼ぶ)。
  const baseAtRisk = atRiskCount(base);

  const addMeasured = (label, result, { pressed, assumption = null, key = null } = {}) => {
    if (!isObj(result) || result === base) return;
    if (seen.has(label) || seenResults.has(result)) return;
    seen.add(label);
    seenResults.add(result);
    const after = atRiskCount(result);
    const delta = baseAtRisk - after;
    measured.push({
      // 🚨 鍵はシナリオのID。改善・教育タブ(rankImprovements)も同じ物で並べる。
      //   名札で並べると、同点の時に2つの画面が違う手を『一番効く手』に出す。
      key: String(key == null ? label : key),
      label,
      /** 危険なロットが何件減るか(正が「良くなる」)。改善・教育タブと**同じものさし**。 */
      effect: delta,
      effectUnit: '件',
      measure: REMEDY_MEASURE,
      /** 人がその手を押して計算したか。押していない仮定は false。 */
      pressed: pressed === true,
      assumption: pressed === true ? null : assumption,
      /**
       * ⚠ 旧名。値は effect と同じ(危険なロットの減り)。
       *   名前は「遅れ」のままだが中身は危険なロット。画面は effect を読む事。
       *   古い読み手を黙って壊さない為だけに残している。
       */
      deltaLate: delta,
      sentence: delta > 0
        ? `危険なロットが ${baseAtRisk}件 → ${after}件。${delta}件ぶん減ります。`
        : (delta === 0
          ? `危険なロットは ${baseAtRisk}件のまま変わりません。`
          : `危険なロットが ${baseAtRisk}件 → ${after}件。${-delta}件ぶん増えます。`),
    });
  };

  // 🚨 T019 / 仕様書5.8: **同じ土俵で計算した物だけ**を「測定済みの効果」にする。
  //   指紋か基準時刻が違うシナリオを混ぜると、条件の違いで出た差を
  //   「この手が効いた」と読ませてしまう。効き目が一番大きく見える事が多いので特に危険。
  //   照合できない(呼ぶ側が指紋を渡していない)時は今まで通り全部使う。
  const rejected = [];
  const sameGround = (s) => {
    if (inputFingerprint == null && baseNow == null) return true;
    const fpOk = inputFingerprint == null || s.inputFingerprint === undefined
      || s.inputFingerprint === inputFingerprint;
    const nowOk = baseNow == null || s.baseNow === undefined || s.baseNow === baseNow;
    return fpOk && nowOk;
  };

  // 全員がどの工程も持てる仮定(指示書4章-1 / 5.8-4)。
  // 「多能工化や応援でどこまで戻るか」の上限を、そのまま対策の効き目として出せる。
  // ⚠ これは base と同じ入力・同じ時刻で回した物なので、土俵の照合は要らない。
  //
  // 🚨🚨 2026-09-01 矛盾Aの直し。これは **人が押していない仮定** である。
  //   直す前は押した手と同じ入れ物へ黙って混ぜていた。しかも worker.js は
  //   scenarios:[] を渡す(＝押した手が1つも入っていない)ので、
  //   今日の判断の『一番効く手』は押した手に関係なく**いつもこれ**になっていた。
  //   → pressed:false の印を付ける。remedyRank.js が best には選ばない。
  //     画面には別の言葉『手が届く上限（押していない仮定）』で出す。
  addMeasured('全員がどの工程も持てるようにする（応援・多能工化の上限）', all, {
    pressed: false,
    assumption: REMEDY_ASSUMPTION_NOTE,
    key: SCENARIO_ID.ALL_SKILLS,
  });
  for (const s of list) {
    if (!sameGround(s)) {
      rejected.push({
        label: labelOf(s),
        // 🚨 どちらで弾いたかを正しく言う。理由が違うと、直す人が別の所を直しに行く。
        //   ⚠ inputFingerprint を渡されていない時は指紋の照合をしていないので、
        //     それを理由に挙げてはいけない。
        reason: (inputFingerprint != null
          && s.inputFingerprint !== undefined
          && s.inputFingerprint !== inputFingerprint)
          ? '入力の指紋が違うので比べていません'
          : '基準時刻が違うので比べていません',
      });
      continue;
    }
    // 🚨 呼ぶ側が渡したシナリオ＝人が押した手。best に選べるのはこちらだけ。
    //   鍵は s.id（改善・教育タブの scenarioId と同じ物）。無ければ名札で代用する。
    addMeasured(labelOf(s), s.result, {
      pressed: true,
      key: (s.id == null || String(s.id) === '') ? labelOf(s) : String(s.id),
    });
  }

  // 🚨 並べ方も『一番効く手』の選び方も remedyRank.js **ただ1本**。
  //   改善・教育タブ(scenarios.js rankImprovements)が呼ぶのと同じ関数。
  //   ここで sort と find を書き直すと、2つの画面がまた違う手を指す。
  const ranked = rankRemedies({ items: measured });

  // 原因に効く手。まだ数字で測っていないので effect / deltaLate は null。
  const hints = [];
  for (const c of causes) {
    const hint = REMEDY_HINT[c.cause];
    if (!hint || seen.has(hint.label)) continue;
    seen.add(hint.label);
    hints.push({
      key: hint.label, label: hint.label,
      effect: null, effectUnit: '件', measure: REMEDY_MEASURE,
      pressed: false, assumption: null,
      deltaLate: null, sentence: hint.sentence,
    });
  }

  // 🚨 土俵が違って比べなかった物は、**効果の数字を持たせずに** 末尾へ置く。
  //   黙って消すと「その手は試していない」事が画面から分からなくなる。
  const notCompared = rejected.map((r) => ({
    key: r.label,
    label: r.label,
    effect: null, effectUnit: '件', measure: REMEDY_MEASURE,
    pressed: false, assumption: null,
    deltaLate: null,
    sentence: `${r.reason}。同じ入力・同じ基準時刻で計算し直すと効き目を出せます。`,
    notCompared: true,
  }));

  return {
    list: [...ranked.ranked, ...hints, ...notCompared],
    /** 🚨 押した手の中で一番効く手。改善・教育タブと**同じ規則・同じものさし**。 */
    best: ranked.best,
    /** 🚨 押していない仮定の上限。best と同じ言葉で出さない。 */
    ceiling: ranked.ceiling,
    measure: ranked.measure,
    measureLabel: ranked.measureLabel,
  };
}
