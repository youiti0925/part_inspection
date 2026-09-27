import { lockOf } from '../planControl/engineLocks.js';
// ============================================================================
// ⏱ simulate.js — 未来の時間を進めながら、人を仕事へ配る本体
// ----------------------------------------------------------------------------
// 出典: 是正指示書「実績監査ではなく操業シミュレーターを作る」5.3〜5.6 /
//       CONTRACT.md の simulate.js の節。
//
// ここが答えるのは1つだけ:
//   「今いる人・今の勤務時間・今分かっている力量で、これから来る仕事を
//     納期線までに片付けられるか。片付けられないなら、いつ・どれが越えるか」
//   原因の分類と対策は explain.js。工程の順番と優先度は priority.js。
//   勤務時間の勘定は calendar.js。ここは **時間を進めて人を貼る** 事だけをやる。
//
// 🚨 決め事(CONTRACT.md 0章)
//   - React / Firebase を import しない。
//   - 関数の中で現在時刻や乱数を読まない。今の時刻は normalized.now から始める。
//     → 同じ入力なら毎回まったく同じ結果(S23)。
//   - 分からない値を推測で埋めない。分からない仕事は unresolved へ理由付きで出す。
//   - 現場の数字(勤務時間・間接係数・しきい値)を直書きしない。calendar と scenario から。
//
// ----------------------------------------------------------------------------
// 【方式】イベント駆動(指示書5.4)
//   0.1時間刻みで全件を何度も見に行く総当たりは持ち込まない。
//   時計は「次に何かが起きる時刻」へ直接飛ぶ。飛び先の候補は
//     ・作業の完了       ・ロットの到着
//     ・働ける/働けないの切り替わり(始業・休憩・終業・休み)
//     ・画面の目盛り(+0.3日)  ・期間の終わり
//   これで5日ぶんが数十回の繰り返しで終わる。
//
// 【この実装が必ず守る事】
//   S01 仕事が終わった **同じ時刻に** 全候補を見直して次を配る。
//   S02 適格な仕事が残っているのに人を空けない。空ける時は idleLog へ必ず理由を書く。
//   S03 作業中も実時刻は進む。カードの横位置は時刻の進み具合で出す(下の duePosRatio)。
//   S10 設備は同時に2件を処理しない(equipmentId が入った時に効く)。
//   S16 目標時間が無い仕事は置かない。unresolved へ理由付きで出す。
//   S17 納期が分からないロットは「遅れ」に数えない。
//   🚨 未入荷のロットに、到着より前の開始時刻を置かない。
//
// ----------------------------------------------------------------------------
// 【入力】simulateOperations({ normalized, eligibility, calendar, scenario }, opts)
//   normalized  … normalizeInput.js の戻り値
//   eligibility … historyEligibility.buildEligibility() の戻り値
//   calendar    … makeCalendar() の戻り値。省略時は normalized.calendarSpec から作る
//   scenario    … { snapshotEveryMs, ojt, switchGainThresholdMs, safetyFactor }
//                 ⚠ 勤務時間・休み・残業は **calendar 側**(makeCalendar の spec)で表す。
//                   ここでは受けない(2箇所で同じ事を決めない)。
//   opts        … { signal } … AbortSignal。中止できる事(S25)
// ============================================================================

import { buildJobs } from './buildJobs.js';
import { makeCalendar } from './calendar.js';
import { compareJobs, reserveSpecialist, slackMs } from './priority.js';
import { EVIDENCE } from './historyEligibility.js';
// ── 🆕 2026-09-10 「実際の生産に近い状態で」の配線(全部 既定 OFF) ─────────────
// 🚨 5本とも **渡されなければ1行も動かない**。数字の作り方はそれぞれの純関数ただ1本で、
//   ここでは掛け算も足し算も書かない(2か所で同じ事を決めない)。
//   ・equipmentGate     … 設備の取り合い。区画の門と同じ形(kind:'wait-equipment')
//   ・applyReworkRate   … 修正のぶんを工数へ上乗せ
//   ・applyWorkerSpeed  … 人ごとの速さを工数へ掛ける
//   ・setupExtraSec     … 型式の切り替えぶんを工数へ足す
//   ・applyInterruption … 中断。⚠ 工数には足さず **終わる時刻を後ろへずらす**
import { equipmentGate, EQUIPMENT_FULL_LABEL } from './equipmentCapacity.js';
import { applyReworkRate, REWORK_MODE } from './reworkRate.js';
import { applyWorkerSpeed, SPEED_MODE } from './workerSpeed.js';
import { setupExtraSec, SETUP_MODE, BASE_KIND } from './setupChange.js';
import { applyInterruption, INTERRUPTION_MODE } from './interruptionRate.js';
import { ESTIMATE_SOURCE } from './estimate.js';
// ── 👥 2026-09-10 分担の区切り(1台の途中で人を替えない)。🚨 既定 OFF ────────────
// 清水さん(2026-09-10 納期一覧の写真を見て):
//   「分担するときはできたら一台毎で区切る感じじゃないとだめだからね、
//     区切りの良いところで分担ならOKね」「なんで分担したって書いてないからわかりづらい」
// 🚨 scenario.handoff を渡さなければ 'none' で、割付も見込みも指紋も1バイト変わらない。
// 🚨 文言(待ちの理由・替わった理由)は handoff.js ただ1本から出す。ここで書き直さない。
import {
  HANDOFF_MODE, HANDOFF_WAIT_KIND, HANDOFF_WAIT_LABEL,
  normalizeHandoffMode, unitKeyOf, handoffGate, splitWhy, SPLIT_KIND,
} from './handoff.js';
// ── 🧵 2026-09-10 ロットは持ったら最後まで / 優先度の区分。🚨 既定 OFF ───────────────
// 清水さん(2026-09-10 23:30 人ごとの指示の写真2枚を見て):
//   「なんでこんなぐちゃぐちゃの仕事になるの？これならロット処理して次のロットでいいでしょ」
//   「優先度で通常と特注と緊急にして、優先度は緊急＞特注＞通常…シミュレーション時の優先度に反映」
// 🚨 scenario.lotFocus / scenario.priorityClass を渡さなければ 割付も見込みも指紋も1バイト変わらない。
// 🚨 「ロットを離れた理由」の文は lotFocus.js ただ1本から出す。ここで書き直さない。
import {
  lotSwitchWhy, lotLabelOf, waitKeyOfOutcome, priorityClassRank, PRIORITY_CLASS, LOT_SWITCH_KIND, LOT_WAIT,
} from './lotFocus.js';

/**
 * ロット×工程 の鍵。⚠ 長さを頭に付けるのは soloDependency.processKeyOf と同じ理由で、
 *   区切り文字がロット番号や工程idの中に出てきても2つの鍵が同じにならない様にする為。
 */
const lotStepKeyOf = (lotId, stepId) => {
  const a = String(lotId ?? '');
  return `${a.length}:${a}:${String(stepId ?? '')}`;
};

// ── 待機の理由 ───────────────────────────────────────────────────────────────
/**
 * 指示書6.4「適格な仕事が残っているのに『待機』と出す場合は、設備待ち・前工程待ち・
 * 技能不足などの理由を必須にする」。
 *
 * ⚠ 指示書が挙げている7種(設備待ち / 前工程待ち / 技能の当てが無い / 休み / 他の作業 /
 *   勤務時間外 / 仕事なし)に、3つだけ足してある。足した理由:
 *     ARRIVAL   … 「まだ物が着いていない」を「前工程待ち」と書くと嘘になる。
 *     RESERVED  … 「その人しか頼めない仕事のために手を空けている」(指示書5.6)は
 *                 上の7種のどれとも違う。7種のどれかへ寄せると理由が嘘になる。
 *     ROSTER_UNKNOWN … 勤務表に見た事の無い記号が入っていた。出勤とも休みとも決めない。
 *   🚨 分からない物を分かった事にしない、という決め事の側を優先した。
 */
export const IDLE_REASON = Object.freeze({
  PLAN_FIXED: '保存計画で別の担当に固定されています',
  EQUIPMENT: '設備待ち',
  PREV_STEP: '前工程待ち',
  NO_SKILL_MATCH: '技能の当てが無い',
  OFF: '休み',
  OTHER_WORK: '他の作業',
  // 🧷👤 2026-09-17 残っている仕事が「前回の担当か 優先の人の手が空くのを待つ物」だけ。
  //   待つのは納期に余裕がある間だけ(tryAssign の hold)。理由を言う側と塞ぐ側はセット。
  HELD: '前回の担当か優先の人が空くのを待つ仕事だけ残っています',
  // 👥 2026-09-16 配置で向こうの工場の応援に行っている(清水さん「どのグループ応援してるか記載して」)。
  //   休み('off')とは別の記号(support:◯◯)から来る。休みに丸めない。
  SUPPORT_PRODUCT: '製品検査の応援',
  SUPPORT_FINAL: '最終検査の応援',
  OUT_OF_HOURS: '勤務時間外',
  NO_JOB: '仕事なし',
  ARRIVAL: '入荷待ち',
  RESERVED: '専門の作業のために手を空けています',
  // 🚨 説明できない空き。もっともらしい札を貼るより、言えない事を言う。
  UNEXPLAINED: '手が空いていますが、理由をまだ言えません',
  NO_TARGET_TIME: '残っている仕事に目標の作業時間が入っていません',
  ROSTER_UNKNOWN: '休み（勤務表の記号が読めません）',
  // 🏭 作業する区画(場所)が満杯。清水さん(2026-09-06)「作業している場所が被ってる人いたわ」。
  //   ⚠ 塞ぐ側(tryAssign)と 理由を言う側(idleReasonFor)は必ずセットで足す。
  //     片方だけだと画面に UNEXPLAINED('理由をまだ言えません')が出る。
  ZONE_FULL: '作業する場所が空くのを待っています',
  // 🔧 2026-09-10: 設備(測定機など)の台数が埋まっている。
  //   ⚠ 上の EQUIPMENT('設備待ち')は「その設備を1件が握っている」古い門の言葉。
  //     こちらは「同時に何台まで」を数えた新しい門。言葉を分けるのは、画面で
  //     『1台しかない物を取り合っている』と『台数の上限に当たった』を混ぜない為。
  //   🚨 塞ぐ側(tryAssign)と 理由を言う側(idleReasonFor / idleReason.js)は必ずセット。
  //     文言は equipmentCapacity.js の EQUIPMENT_FULL_LABEL ただ1本から取る。
  EQUIPMENT_FULL: EQUIPMENT_FULL_LABEL,
  // 👥 2026-09-10: 「1台は同じ人が最後まで」の設定で、その台を持っている人の手が
  //   空くのを待っている。清水さん「一台毎で区切る感じじゃないとだめ」。
  //   ⚠ 塞ぐ側(tryAssign)と 理由を言う側(idleReasonFor / idleReason.js)は必ずセット。
  //     片方だけだと画面に UNEXPLAINED('理由をまだ言えません')が出る(ZONE_FULL の時と同じ穴)。
  //   文言は handoff.js の HANDOFF_WAIT_LABEL ただ1本から取る。
  HANDOFF: HANDOFF_WAIT_LABEL,
});

/**
 * 手が付かなかった仕事の理由。
 * 🚨 「時間が足りなかっただけ」の仕事は **ここへ出さない**。
 *   それは遅れであって、判定できなかった訳ではない。混ぜると
 *   explain 側で「総時間不足」と「入力不足」の区別が付かなくなる。
 * ⚠ explain.js がこの定数と突き合わせて原因を分ける。文言を直書きで比べない。
 */
export const UNRESOLVED_REASON = Object.freeze({
  DURATION_UNKNOWN: '目標の作業時間が分かりません',
  ARRIVAL_UNKNOWN: '到着の予定が分かりません',
  NO_CANDIDATE: 'この工程をやった記録も、スキルの登録も見当たりません',
  ALL_CANDIDATES_AWAY: '担当の候補がこの期間ずっと休みです',
  // 👥 2026-09-16 候補が全員 **同じ工場の応援** に行っている時だけ、その工場の名前を言う(allAwayReason)。
  ALL_CANDIDATES_SUPPORT_PRODUCT: '担当の候補がこの期間ずっと製品検査の応援です',
  ALL_CANDIDATES_SUPPORT_FINAL: '担当の候補がこの期間ずっと最終検査の応援です',
  NO_WORK_TIME: 'この期間に働ける時間が1分もありません',
  PREV_UNRESOLVED: '前の工程が手つかずのままです',
  TOO_LONG: '働ける時間の中に収まりませんでした',
  // 📌 2026-09-15 手で決めた担当(pins)
  PINNED_NOT_ELIGIBLE: '固定した担当にこの工程の記録がありません',
  PINNED_NONE: '手で「この期間は誰にも当てない」にしています',
});

/**
 * ロットごとに「遅れるかどうかを言えなかった」理由。
 * 🚨 これを late に混ぜてはいけない。混ぜると「能力が足りない」という嘘の結論になる。
 */
export const UNJUDGEABLE = Object.freeze({
  NO_DUE: '納期の記録がありません',
});

/**
 * 「判定できない」に落としてよい理由。**入力が足りない物だけ**。
 * 🚨 NO_CANDIDATE(やった記録が無い) / ALL_CANDIDATES_AWAY(全員休み) / NO_WORK_TIME は
 *   ここへ入れない。入れると「人が足りないのに守れる」と出る。
 */
const INPUT_MISSING_REASONS = new Set([
  UNRESOLVED_REASON.DURATION_UNKNOWN,
  UNRESOLVED_REASON.ARRIVAL_UNKNOWN,
]);

/**
 * ロットに複数の理由がある時、どれを代表にするか。
 * 「回せる人がいない」系を優先する(遅れとして数える側)。PREV_UNRESOLVED は
 * 同じロットの前の工程が原因なので、他に理由があればそちらを採る。
 */
function pickBlockedReason(reasons) {
  if (!reasons || reasons.size === 0) return null;
  const order = [
    UNRESOLVED_REASON.PINNED_NONE,
    UNRESOLVED_REASON.PINNED_NOT_ELIGIBLE,
    UNRESOLVED_REASON.NO_CANDIDATE,
    UNRESOLVED_REASON.ALL_CANDIDATES_AWAY,
    UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_PRODUCT,
    UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_FINAL,
    UNRESOLVED_REASON.NO_WORK_TIME,
    UNRESOLVED_REASON.TOO_LONG,
    UNRESOLVED_REASON.DURATION_UNKNOWN,
    UNRESOLVED_REASON.ARRIVAL_UNKNOWN,
    UNRESOLVED_REASON.PREV_UNRESOLVED,
  ];
  for (const r of order) if (reasons.has(r)) return r;
  return [...reasons][0];
}

/** 画面へ出す作業者の状態。 */
export const WORKER_STATE = Object.freeze({
  WORKING: 'working',
  WAITING: 'waiting',
  AWAY: 'away',
});

/** 記録を残しすぎて画面が固まらないための上限。 */
const MAX_SNAPSHOTS = 600;
/** 1件の配置につき、根拠として残す候補者の数の上限。 */
const MAX_AUDIT_CANDIDATES = 12;

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const isFn = (v) => typeof v === 'function';
const finite = (v) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/**
 * 並べ替えの最後の決め手。
 * ⚠ localeCompare を使わない。端末の言語データで並びが変わると、
 *   同じ入力でも別の結果になる(S23 が端末をまたいだ時に崩れる)。
 */
const cmpId = (a, b) => {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
};

const trimmedName = (v) => {
  if (typeof v === 'string') return v.trim();
  if (isObj(v)) return String(v.name ?? '').trim();
  return '';
};

// ============================================================================
// 本体
// ============================================================================

/**
 * @param {object} input { normalized, eligibility, calendar, scenario }
 * @param {object} [opts] { signal }
 * @returns {object} CONTRACT.md simulate.js の節の形
 */
export function simulateOperations(input = {}, opts = {}) {
  const state = initialize(input, opts);

  let rounds = 0;
  while (state.now < state.horizonEnd) {
    // 🚨 暴走止め。時計が進まない書き間違いをした時に、黙って固まらせない。
    if (++rounds > state.maxRounds) {
      throw new Error(
        `simulateOperations: 時間を進める繰り返しが ${state.maxRounds} 回を超えました。`
        + ' 次の出来事の時刻が前へ進んでいません（作業時間0の仕事・勤務時間の設定を確かめてください）',
      );
    }
    throwIfAborted(state);

    closeCompletedWork(state);
    releaseUnavailableAssignments(state);

    const runnable = buildRunnableTasks(state);
    const decisions = assignAllIdleWorkers({ state, runnable });
    state.audit.push(...decisions);

    // 骨格(指示書5.4)に無い1行。指示書6.4「理由の無い待機を出さない」を満たすために要る。
    // 配置の後に見る事で、「配ろうとしたが配れなかった」理由がそのまま残る。
    recordIdle(state, runnable);

    const nextAt = nextEventAt(state);
    advanceWorkAndClock(state, nextAt);
    recordSnapshotIfNeeded(state);
    recordMilestones(state);
  }

  // 期間の終わりまで来た。最後に、まだ動いている作業と待機を締める。
  throwIfAborted(state);
  closeCompletedWork(state);
  return finalizeResult(state);
}

export default simulateOperations;

// ----------------------------------------------------------------------------
// initialize
// ----------------------------------------------------------------------------
function initialize(input, opts) {
  if (!isObj(input) || !isObj(input.normalized)) {
    throw new Error('simulateOperations: normalized（normalizeInput の戻り値）を渡してください');
  }
  const normalized = input.normalized;
  const now = finite(normalized.now);
  if (now == null) {
    // 🚨 ここで現在時刻を読むと「同じ入力→同じ結果」(S23)が壊れる。黙って補わない。
    throw new Error('simulateOperations: normalized.now（今の実時刻 epoch ms）が要ります');
  }
  const horizonEnd = finite(normalized.horizonEnd);
  if (horizonEnd == null) {
    throw new Error('simulateOperations: normalized.horizonEnd（どこまで見るか）が要ります');
  }

  const eligibility = input.eligibility;
  if (!isObj(eligibility) || !isFn(eligibility.eligibleFor)) {
    // 候補が分からないまま走らせると、全部「頼める人が居ない」になり、
    // 技能の偏りという嘘の結論が出る。黙って空で走らせない。
    throw new Error('simulateOperations: eligibility（buildEligibility の戻り値）を渡してください');
  }

  // カレンダーは呼ぶ側が作って渡すのが本筋(勤務時間の選択は画面が決める)。
  // 渡されなかった時だけ、正規化が持っている設定から組む。
  const calendar = (isObj(input.calendar) && isFn(input.calendar.addWorkMs))
    ? input.calendar
    : makeCalendar(normalized.calendarSpec || {});

  const scenario = isObj(input.scenario) ? input.scenario : {};
  const options = isObj(opts) ? opts : {};

  const jobs = buildJobs(normalized);

  const lotById = new Map();
  const jobsByLot = new Map();
  const stepTitleByLot = new Map();
  const totalMsByLot = new Map();
  for (const lot of (Array.isArray(normalized.lots) ? normalized.lots : [])) {
    lotById.set(lot.lotId, lot);
    jobsByLot.set(lot.lotId, []);
    const titles = new Map();
    let total = 0;
    const qty = Math.max(1, Math.trunc(Number(lot.quantity)) || 1);
    for (const s of (Array.isArray(lot.steps) ? lot.steps : [])) {
      titles.set(Number(s.index), String(s.title ?? ''));
      const sec = finite(s.targetSec);
      // 進み具合のバーの分母(PANEL_SPEC 3章)。分からない工程は足さない。
      if (sec != null && sec > 0) total += Math.round(sec * 1000) * (s.perUnit === false ? 1 : qty);
    }
    stepTitleByLot.set(lot.lotId, titles);
    totalMsByLot.set(lot.lotId, total);
  }
  for (const job of jobs) {
    const list = jobsByLot.get(job.lotId);
    if (list) list.push(job);
    else jobsByLot.set(job.lotId, [job]);
  }

  // 🚨 人の並びを固定する。購読の順で結果が変わらないようにする(S23)。
  const workers = (Array.isArray(normalized.workers) ? normalized.workers : [])
    .map((w) => ({ workerId: String(w?.workerId ?? ''), name: trimmedName(w) }))
    .filter((w) => w.name)
    .sort((a, b) => cmpId(a.workerId, b.workerId) || cmpId(a.name, b.name));
  const workerNames = [];
  const rosterSet = new Set();
  for (const w of workers) {
    if (rosterSet.has(w.name)) continue; // 同姓同名は1人として扱う(名前で人を見分けるため)
    rosterSet.add(w.name);
    workerNames.push(w.name);
  }

  // OJT の仮配置(S22)。工程 → { mentor, trainee }。
  const ojtByProcess = new Map();
  for (const row of (Array.isArray(scenario.ojt) ? scenario.ojt : [])) {
    const key = String(row?.processKey ?? '');
    const mentor = trimmedName(row?.mentor);
    const trainee = trimmedName(row?.trainee);
    if (!key || !mentor || !trainee || mentor === trainee) continue;
    if (!ojtByProcess.has(key)) ojtByProcess.set(key, { mentor, trainee });
  }

  /**
   * 🚨 2026-08-24 清水さん「ひとつの型式を一人でするっていう前提をONするところもほしい」
   *   「基本は一人なんだけど、ものによっては二人でできる」。
   *
   * 🚨 **意味は2通りあり、どちらかは決まっていません**。ここでは (a) を実装しています。
   *   (a) 同じ型式を **同時に** 2人が触らない  ← いまこちら
   *   (b) その型式は最初に触った人が最後まで全部持つ
   *   (b) にすると、1つの型式に最大50ロット付く型式があるので、その50件が
   *   丸ごと1人へ乗り、遅れが跳ね上がります。どちらを指しているかは清水さんに要確認。
   *
   * 🚨 渡されなければ **1行も動きません**（空 Set と false で素通りする）。
   *   ＝設定を作るまで、いままでの計算と1ミリも変わらない。
   * ⚠ 既存の OJT とは別物。OJT は「教える為に2人」で、所要時間は縮まない。
   */
  const twoPersonProcessKeys = new Set(
    (Array.isArray(scenario.twoPersonProcessKeys) ? scenario.twoPersonProcessKeys : [])
      .map((k) => String(k)).filter(Boolean),
  );
  const oneWorkerPerModel = scenario.oneWorkerPerModel === true;

  // ── 🏭 区画(エリア)の定員 ────────────────────────────────────────────────
  // 清水さん(2026-09-06)「作業するエリアも意識しないとだめかな。今シミュレーション見てたら
  //   作業している場所が被ってる人いたわ。過去データからそこも意識するようにしてほしい」
  // 形は { 区画id: 何人まで }。作るのは画面側(domain/operationsSimulation/zoneCapacity.js)で、
  //   人が決めた数 → 過去の実測(同時に居た最大人数) → 制限しない、の順。
  // 🚨 渡されなければ **1行も動かない**(空の Map で素通り)＝いままでの計算と1ミリも変わらない。
  //   oneWorkerPerModel / twoPersonProcessKeys と同じ流儀。
  const zoneCapacity = new Map();
  {
    const src = scenario.zoneCapacity;
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        const id = String(k || '').trim();
        // ⚠ 1以上の整数だけ。0・小数・文字・真偽は「決めていない」として捨てる(黙って丸めない)。
        //   🚨 true は Number(true)===1 なので、明かに数でない物は先に外す
        //     (「はい」を定員1人と読み替えると、書いた人の意図と違う盤になる)。
        const n = (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
        if (id && Number.isInteger(n) && n >= 1) zoneCapacity.set(id, n);
      }
    }
  }

  // 区画の名前(画面と同じ言い方で理由を書く為だけ。計算には1バイトも効かない)
  const zoneName = new Map();
  {
    const src = scenario.zoneNames;
    if (src && typeof src === 'object') {
      for (const [k, v] of Object.entries(src)) {
        const id = String(k || '').trim();
        const nm = String(v || '').trim();
        if (id && nm) zoneName.set(id, nm);
      }
    }
  }

  // ── 👤 この人はこのテンプレを優先 ────────────────────────────────────────
  // 清水さん(2026-09-06)「個人設定でテンプレ毎に この人はこのテンプレを優先的にする設定もほしい」
  // 形は { 作業者名: Set(テンプレid) }。
  // 🚨 「できる/できない(能力)」は1バイトも変えない。**同じくらい頼める人が複数居る時の順番** だけ。
  //   能力に混ぜると「優先にしていないから頼めない」になり、実績で出来ると分かっている人を外してしまう。
  const workerTemplatePrefs = new Map();
  {
    const src = scenario.workerTemplatePrefs;
    if (src && typeof src === 'object') {
      for (const [name, tpls] of Object.entries(src)) {
        const who = String(name || '').trim();
        if (!who || !tpls || typeof tpls !== 'object') continue;
        const set = new Set();
        // 並び(配列)でも 表({id:true})でも読む。⚠設定は配列で持つ(merge:true では
        //   表から1つ消しても消えない。配列なら丸ごと置き換わる)。
        if (Array.isArray(tpls)) {
          for (const tid of tpls) { const id = String(tid || '').trim(); if (id) set.add(id); }
        } else {
          for (const [tid, on] of Object.entries(tpls)) {
            const id = String(tid || '').trim();
            if (id && on === true) set.add(id);
          }
        }
        if (set.size > 0) workerTemplatePrefs.set(who, set);
      }
    }
  }

  // ── 🧷 前回の担当(lotId → 名前)。2026-09-17 ─────────────────────────────
  // 清水さん(2026-09-16)「納期一覧で作業者変えて計算したら、ぐちゃぐちゃになった」。写しの実測: 1件を固定すると
  //   他の10ロットの担当が入れ替わった(貪欲法は空いた人に仕事を回すので、1つ動くと連鎖する)。
  //   → 画面が前回の答えの主担当を scenario.prevWorkers で渡す。効くのは **並びの好み** と、
  //     納期に余裕がある間だけ **その人を待つ**(下の hold)。渡されなければ1行も動かない。
  //   🚨 指紋(inputFingerprint)には混ぜない(前回の答えは「同じ土俵か」の材料ではない)。
  const prevWorkersMap = new Map();
  {
    const src = scenario.prevWorkers;
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      for (const [lotId, name] of Object.entries(src)) {
        const l = String(lotId || '').trim(); const n = String(name || '').trim();
        if (l && n) prevWorkersMap.set(l, n);
      }
    }
  }
  // 👤 「このテンプレを優先」の強さ。'order'(順番だけ・今まで) | 'reserve'(その人の手が空くまで他の人に渡さない。納期に余裕がある間だけ)
  const templatePrefMode = scenario.templatePrefMode === 'reserve' ? 'reserve' : 'order';

  // ── 👥 分担の区切り(1台の途中で人を替えない) ────────────────────────────
  // 🚨 渡されなければ 'none' = いままでと1バイトも同じ答え。
  //   本筋は scenario.handoff。normalized.handoff は normalizeInput が同じ字を写した物で、
  //   scenario を渡さずに正規化の結果だけで走らせる呼び方(道具・試験)のための控え。
  // 🚨 読める字だけ通す(true や 1 を「はい」と読み替えない)のは handoff.js の1本に任せる。
  const handoffMode = normalizeHandoffMode(
    scenario.handoff === undefined ? normalized.handoff : scenario.handoff,
  );

  // ── 🧵 ロットは持ったら最後まで / 優先度の区分(2026-09-10) ─────────────────────
  // 🚨 鍵は scenario.lotFocus === true / scenario.priorityClass === true **ただ2つ**。
  //   true 以外は「立っていない」(handoff と同じで、読み替えない)。
  //   scenario に無い時だけ normalized の控え(normalizeInput が同じ字を写した物)を見る。
  // 🚨 渡されなければ **1行も動かない**: continuePass は呼ばれず、compareJobs の0番目の鍵も
  //   立たず、結果に lotSwitches の鍵も出ない = いままでの計算と1ミリも変わらない。
  const lotFocusOn = (scenario.lotFocus === undefined ? normalized.lotFocus : scenario.lotFocus) === true;
  const priorityClassOn = (scenario.priorityClass === undefined ? normalized.priorityClass : scenario.priorityClass) === true;

  // ── 🆕 「実際の生産に近い状態で」の5本(2026-09-10) ──────────────────────────
  // 🚨 全部 **scenario に何も書かなければ切ってある**。zoneCapacity と同じ流儀で、
  //   空の Map / 'off' のまま素通りする = いままでの計算と1ミリも変わらない。
  // 🚨 数字を作る所は それぞれの純関数ただ1本。ここは「読む・渡す・受け取る」だけ。

  // 🔧 設備の取り合い。形は equipmentCapacity.buildEquipmentCapacity() の戻りをそのまま。
  //   { capacity: { 設備id: 何台まで }, stepEquipment: { 工程キー: 設備id } }
  //   ⚠ 区画は **人** を数えるが、設備は **台**。2人で1台を触っても埋まるのは1台。
  const equipmentCap = new Map();
  const equipmentOfStep = new Map();
  {
    const src = scenario.equipmentCapacity;
    if (src && typeof src === 'object') {
      const caps = (src.capacity && typeof src.capacity === 'object') ? src.capacity : null;
      if (caps) {
        for (const [k, v] of Object.entries(caps)) {
          const id = String(k || '').trim();
          // ⚠ 1以上の整数だけ。区画と同じで、数でない物・0・小数は「決めていない」として捨てる。
          const n = (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
          if (id && Number.isInteger(n) && n >= 1) equipmentCap.set(id, n);
        }
      }
      const steps = (src.stepEquipment && typeof src.stepEquipment === 'object') ? src.stepEquipment : null;
      if (steps) {
        for (const [k, v] of Object.entries(steps)) {
          const key = String(k || '').trim();
          const id = String(v == null ? '' : v).trim();
          // 🚨 上限を決めていない設備は索引にも入れない。入れると門は素通りするのに
          //   idleReasonFor だけが「設備が空くのを待っています」と言い出す(理由が嘘になる)。
          if (key && id && equipmentCap.has(id)) equipmentOfStep.set(key, id);
        }
      }
    }
  }

  /** 🔁 修正率。'off'(既定) | 'median' | 'p75' */
  const reworkMode = (scenario.reworkMode === REWORK_MODE.MEDIAN || scenario.reworkMode === REWORK_MODE.P75)
    ? scenario.reworkMode : REWORK_MODE.OFF;
  const reworkRates = reworkMode !== REWORK_MODE.OFF ? (scenario.reworkRates || null) : null;
  const reworkUseAll = scenario.reworkUseAll === true;

  /** ⏸ 中断。'off'(既定) | 'median' | 'p75' */
  const interruptionMode = (scenario.interruptionMode === INTERRUPTION_MODE.MEDIAN
    || scenario.interruptionMode === INTERRUPTION_MODE.P75)
    ? scenario.interruptionMode : INTERRUPTION_MODE.OFF;
  const interruptionRates = interruptionMode !== INTERRUPTION_MODE.OFF ? (scenario.interruptionRates || null) : null;
  const interruptionUseAll = scenario.interruptionUseAll === true;

  /** 🏃 人ごとの速さ。'off'(既定) | 'workerStep' | 'workerStepOnly' | 'worker' */
  const workerSpeedMode = (scenario.workerSpeedMode === SPEED_MODE.WORKER_STEP
    || scenario.workerSpeedMode === SPEED_MODE.WORKER_STEP_ONLY
    || scenario.workerSpeedMode === SPEED_MODE.WORKER)
    ? scenario.workerSpeedMode : SPEED_MODE.OFF;
  const workerSpeed = workerSpeedMode !== SPEED_MODE.OFF ? (scenario.workerSpeed || null) : null;

  /** 🔀 段取り替え。'off'(既定) | 'byStep' | 'all' */
  const setupMode = (scenario.setupChangeMode === SETUP_MODE.BY_STEP || scenario.setupChangeMode === SETUP_MODE.ALL)
    ? scenario.setupChangeMode : SETUP_MODE.OFF;
  const setupChange = setupMode !== SETUP_MODE.OFF ? (scenario.setupChange || null) : null;
  // 上乗せする相手の土台。既定は 'mixed'(estimate.js の目標時間は切り替えの記録も混ざっている)。
  const setupBaseKind = (scenario.setupBaseKind === BASE_KIND.SAME_MODEL_ONLY)
    ? BASE_KIND.SAME_MODEL_ONLY : BASE_KIND.MIXED;

  /**
   * 🔁 その工程の目標時間に「修正の時間」が既に入っているか。
   * 🚨🚨 二重計上の門。estimate.js は 実績(duration + reworks)の分位点を返すので、
   *   実績から出た見積り(model-step / step-group)には **もう修正が入っている**。
   *   目標時間(template-target)や人が入れた補正値(calibrated)は測った値ではないので入っていない。
   *   分からない物は **言わない**(undefined)。applyReworkRate は言われない限り上乗せしない。
   * ⚠ 修正率を切ってある間(既定)は この表を1つも作らない(1回の見立ての作り直しを増やさない)。
   */
  const reworkBaseIncludes = new Map();
  if (reworkMode !== REWORK_MODE.OFF) {
    for (const lot of (Array.isArray(normalized.lots) ? normalized.lots : [])) {
      for (const st of (Array.isArray(lot && lot.steps) ? lot.steps : [])) {
        const src = st && st.estimateSource;
        let includes;
        if (src === ESTIMATE_SOURCE.MODEL_STEP || src === ESTIMATE_SOURCE.STEP_GROUP) includes = true;
        else if (src === ESTIMATE_SOURCE.TEMPLATE_TARGET || src === ESTIMATE_SOURCE.CALIBRATED) includes = false;
        if (includes === undefined) continue;   // 分からない物は言わない
        reworkBaseIncludes.set(lotStepKeyOf(lot.lotId, st.stepId), includes);
      }
    }
  }

  const snapshotEveryMs = (() => {
    const v = finite(scenario.snapshotEveryMs);
    return (v != null && v > 0) ? Math.round(v) : null;
  })();

  // 🚨 2026-08-23: 画面の記録を **「いつ撮るか」を先に決めた一覧** で撮る（仕様の是正）。
  //   それまでは「30分ごと」で、30日にすると上限600枚に当たって
  //   **12.5日ぶんで黙って打ち切られていた**（30日と言いながら30日を見せていない）。
  //   呼ぶ側が snapshotTargets を渡せばそれを使う。
  //   渡されなければ snapshotEveryMs から同じ形の一覧を作る（今までの呼び方も壊さない）。
  const snapshotTargets = (() => {
    const given = Array.isArray(scenario.snapshotTargets) ? scenario.snapshotTargets : null;
    if (given) {
      return given
        .map((t) => ({ elapsedDays: Number(t && t.elapsedDays), targetMs: finite(t && t.targetMs) }))
        .filter((t) => t.targetMs != null)
        .sort((a, b) => a.targetMs - b.targetMs);
    }
    if (snapshotEveryMs == null) return [];
    const out = [];
    // 🚨 2026-08-23: ここで MAX_SNAPSHOTS に切ってから requested と数えると、
    //   **切れているのに complete:true** になって赤い警告が出ない（旧経路にだけ残っていた欠陥）。
    //   要求は要求として最後まで作る。撮れなかった分は snapshotCoverage が正直に出す。
    for (let t = now; t <= horizonEnd; t += snapshotEveryMs) {
      out.push({ elapsedDays: null, targetMs: t });
      if (out.length > MAX_SNAPSHOTS * 4) break;   // 暴走の安全弁（刻みが極端に小さい時だけ）
    }
    return out;
  })();

  const state = {
    normalized,
    eligibility,
    calendar,
    scenario,
    planJobLocks: Object.keys(scenario.planJobLocks || {}).length ? scenario.planJobLocks : null,
    signal: options.signal || null,

    startNow: now,
    now,
    horizonEnd,

    jobs,
    jobById: new Map(jobs.map((j) => [j.jobId, j])),
    jobsByLot,
    lotById,
    stepTitleByLot,
    totalMsByLot,

    workers,
    workerNames,
    rosterSet,
    // 📌 手で決めた担当(2026-09-15)。lotId -> 名前('' = 誰にも当てない)。normalizeInput が名簿と突き合わせ済み。
    //   🚨 空なら Map も空 = 1行も動かない。
    pins: new Map(Object.entries(isObj(normalized.pins) ? normalized.pins : {})),
    // 📌 2026-09-19 やわらかい固定(記録の実際の担当)。その人が候補に居る時だけ絞る。空なら1行も動かない。
    softPins: new Map(Object.entries(isObj(normalized.softPins) ? normalized.softPins : {})),
    ojtByProcess,
    twoPersonProcessKeys,
    oneWorkerPerModel,
    zoneCapacity,          // 🏭 区画id -> 何人まで(空なら1件も制限しない)
    zoneName,              // 区画id -> 名前(理由の文だけに使う)
    workerTemplatePrefs,   // 👤 作業者名 -> 優先するテンプレid の Set(順番だけに効く)
    templatePrefMode,      // 👤 'order' | 'reserve'(2026-09-17)
    prevWorkers: prevWorkersMap,   // 🧷 lotId -> 前回の担当(2026-09-17)
    heldJobIds: new Set(), // 🧷 この回で「その人を待つ」為に止めた仕事(待機の理由に使う)
    // ── 👥 分担の区切り('none' なら門も並べ替えも1件も効かない) ────────────
    handoff: handoffMode,
    // ── 🧵 ロットは持ったら最後まで / 優先度の区分(false なら1行も動かない) ──────
    lotFocus: lotFocusOn,
    priorityClassOn,
    // 🧵 人 -> いま持っているロット(直前に割り付けた仕事のロット)。割付の度に書き替える。
    //   ⚠ lotFocus が切ってある間も書く(書くだけ。読むのは continuePass だけなので答えは変わらない)。
    currentLotOf: new Map(),
    // 🧵 人 -> 直前に割り付けた仕事の開始時刻。続きを配る時の人の順(S23: 名簿の順に依らない)。
    lastStartOf: new Map(),
    // 🧵 ロットid -> 人がそのロットを離れた記録 [{ atMs, worker, fromLotId, toLotId, why }]。
    //   🚨 lotFocus が立っている時だけ積む(切ってある時は結果の形を1バイトも変えない)。
    lotSwitches: new Map(),
    // 🧵 このラウンドで「続きを配ろうとして渡せなかった」内訳。人 -> LOT_WAIT の鍵の Set。
    //   離れた理由の文の材料。ラウンドの頭で空にする。
    continueTried: new Map(),
    // ── 🆕 「実際の生産に近い状態で」(空 / 'off' なら1件も効かない) ──────────
    equipmentCap,          // 🔧 設備id -> 何台まで
    equipmentOfStep,       // 🔧 工程キー -> 設備id(上限を決めた設備だけ)
    reworkMode, reworkRates, reworkUseAll, reworkBaseIncludes,
    interruptionMode, interruptionRates, interruptionUseAll,
    workerSpeedMode, workerSpeed,
    setupMode, setupChange, setupBaseKind,
    // 📊 工数を膨らませる3本が実際に何件へ効いたか(2026-09-10 確かめ役)。
    //   本番の写しで 修正率 p75 を ON にしても 1862件中 0件 にしか掛からず(見積りに修正が入っている 1734件 /
    //   記録が足りない 86件 / 鍵が無い 42件)、画面には何も出なかった(黙った素通り)。
    //   🚨 ON なら結果に realism.{rework,workerSpeed,setupChange} として件数と理由の内訳を載せる。
    //   ⚠ 3本とも切ってある間(既定)は null = 数えないし、結果の形も1バイトも変えない。
    inflation: (reworkMode !== REWORK_MODE.OFF || workerSpeedMode !== SPEED_MODE.OFF || setupMode !== SETUP_MODE.OFF)
      ? {
        rework: { on: reworkMode !== REWORK_MODE.OFF, applied: 0, byCode: {} },
        workerSpeed: { on: workerSpeedMode !== SPEED_MODE.OFF, applied: 0, bySource: {} },
        setupChange: { on: setupMode !== SETUP_MODE.OFF, applied: 0, bySource: {} },
      }
      : null,

    // 進行状態
    doneJobIds: new Set(),
    running: new Map(),        // jobId -> { job, rec, worker, partner, startMs, endMs, equipmentId }
    recordByJob: new Map(),    // jobId -> 上と同じ物。完了しても消さない(過去の記録の再現に使う)
    endMsByJob: new Map(),     // jobId -> 終わる実時刻。手が付いた印でもある
    holderOf: new Map(),       // 人 -> 今持っている jobId
    busyEquipment: new Map(),  // 設備id -> jobId
    // 🔧 いま その設備を何台使っているか。⚠区画(zoneUsed)と同じで、配った時に足し、
    //   解放する時に **自分が足した分だけ** 引く(他人の分を消さない)。
    equipmentUsed: new Map(),  // 設備id -> 台数
    equipmentFullSeen: new Set(), // 「設備の上限で待った」を1つの仕事につき1回だけ記録する為
    // 🔀 その人が直前にやっていた型式。段取り替えを切ってある間は1つも書かない。
    lastModelByWorker: new Map(),
    pendingJobs: jobs.slice(), // まだ手が付いていない仕事(priority へ渡す)
    // 🧪 ラボ専用(scenario.parallelLab が在る時だけ)。無ければ null = 今までの計算と1バイトも同じ
    parallelLab: isObj(scenario.parallelLab) && scenario.parallelLab.release === true ? scenario.parallelLab : null,
    parallelLabStats: { released: 0, finishJobs: 0, travelAdded: 0, travelUnknown: 0, zoneUnknown: 0, excluded: 0, equipmentHeldMs: 0, urgentKept: 0, returnGated: 0 },
    parallelLabReturnGated: new Set(),
    lastZoneOf: new Map(),        // 離れている人が最後に居た場所(往復の起点)
    awayOf: new Map(),            // 人 → 終了対応の jobId(自動中に離れている間だけ)
    movedWhileAway: new Set(),    // 離れている間に別の仕事へ動いた人(動いていなければ帰りの往復は無い)
    awayReturnAtOf: new Map(),    // 人 → { atMs, known, zoneUnknown } 離れて最後の仕事の終わり＋帰りの片道(手が空いたら戻る)
    parallelLabHeld: new Map(),   // 終了対応の jobId → 設備を押さえたままの自動の rec
    parallelLabExcluded: new Set(),
    breadth: new Map(),        // 人 -> 技能の範囲の広さ(残っている仕事で数える)
    eligCache: new Map(),      // 工程 -> { names, evidence }
    workMsCache: new Map(),    // 人 -> この期間に働ける時間
    equipmentWaitSeen: new Set(),
    // 🏭 いま その区画に何人立っているか。⚠設備(busyEquipment)と同じで、配った時に足し、
    //   解放する時に **自分が足した分だけ** 引く(他人の分を消さない)。
    zoneUsed: new Map(),       // 区画id -> 人数
    zoneWaitSeen: new Set(),   // 「場所待ち」を1つの仕事につき1回だけ記録する為
    // 👥 分担の区切り。⚠ unitOwner / lotOwner / unitSplits は **どの設定でも** 書く。
    //   'none' の時も「なぜ分担したか」を残す為(清水さんが見たいのはそこ)。
    //   ⚠ 割付そのものを変えるのは handoff が 'soft'/'unit' の時だけ。
    unitOwner: new Map(),      // 台の鍵(lotId#台) -> その台を持っている人
    lotOwner: new Map(),       // ロットid -> { unitIndex, owner } いちばん先まで進んだ台と その持ち主
    unitSplits: new Map(),     // ロットid -> 人が替わった記録の並び
    handoffWaitSeen: new Set(),// 「同じ台の人を待った」を1つの仕事につき1回だけ記録する為

    // 出力
    assignments: [],
    idleLog: [],
    idleOpen: new Map(),
    snapshots: [],
    audit: [],

    snapshotEveryMs,
    snapshotTargets,
    nextTargetIndex: 0,
    /** 🚨 大事な出来事（納期を越えた瞬間など）。粗い刻みで見落とさない為に別で残す。 */
    milestones: [],
    seenBreachLots: new Set(),
    /**
     * 🚨 2026-09-04（決まり19A・案A の③）: 納期越えの見張りを **対象だけ** に絞る。
     *   前は毎ラウンド **全部のロット** をなめていた。1か月ぶん回すと
     *   ロット163 × 数千ラウンド ＝ 数十万回、その大半が「納期が入っていない」か
     *   「もう記録した」で捨てられるだけだった。
     * 🚨 並びは normalized.lots と **同じ順**。ここを並べ替えると milestones の並びが変わる
     *   ＝ 答えが変わる（速くしたのに数字が動いた、になる）。
     * ⚠ 外すのは2つの場合だけ。どちらも「もう二度と変わらない」事が言える:
     *   ① 納期越えとして記録した（seenBreachLots に入れた ＝ 前も continue していた）
     *   ② そのロットの仕事が全部 doneJobIds に入った（doneJobIds は増える一方）
     */
    milestoneWatch: [],

    // 出来事は「仕事の数 × 工程の乗り換え」ぶんしか起きない。
    // それより桁違いに多い繰り返しは、時計が進んでいない印。
    maxRounds: Math.max(20000, jobs.length * 8 + 20000),
  };

  // 🚨 納期越えの見張りの初期の顔ぶれ。normalized.lots と **同じ順** で、納期線が入っている物だけ。
  //   納期線が無いロットは元の実装でも必ず continue していたので、最初から入れない
  //   （＝答えは1ビットも変わらない。速さだけが変わる）。
  for (const lot of normalized.lots) {
    if (finite(lot.dueLineMs) == null) continue;
    state.milestoneWatch.push(lot);
  }

  return state;
}

function throwIfAborted(state) {
  if (state.signal && state.signal.aborted) {
    const err = new Error('操業シミュレーションを中止しました');
    err.name = 'AbortError';
    throw err;
  }
}

// ----------------------------------------------------------------------------
// 1. 終わった作業を締める
// ----------------------------------------------------------------------------
function closeCompletedWork(state) {
  if (state.running.size === 0) return;
  const finished = [];
  for (const [jobId, rec] of state.running) {
    if (rec.endMs <= state.now) finished.push(jobId);
  }
  for (const jobId of finished) {
    const rec = state.running.get(jobId);
    state.running.delete(jobId);
    state.doneJobIds.add(jobId);
    // 人と設備を **同じ時刻に** 解放する。ここで解放しないと、
    // 終わった直後に次の仕事へ移れない(S01)。
    releaseHolders(state, rec);
  }
}

/* 🧪 ラボ専用(2026-09-22 深夜): 自動運転の工程を「人は開始だけ・設備は終わりまで」に分ける。
   - job が自動(cfg.autoSteps['ロット|工程'] 在り)で 離れてよい(mayLeave===true)・終了対応(finishWorkMin)が登録されている時だけ。
   - 人を即 解放(holderOf を消す)。設備・区画は running のまま(終わりで releaseHolders が外す)。
   - 終了対応の仕事(#finish)を作り pendingJobs へ。afterJobId=自動の仕事・requiredWorker=同じ人。
   - 自動の仕事の後ろに続く仕事(afterJobId===自動)は 終了対応の後ろへ付け替える。
   🚨 scenario.parallelLab が無ければ呼ばれない。 */
function parallelLabRelease(state, job, picked, running) {
  const cfg = state.parallelLab; if (!cfg || !isObj(cfg.autoSteps)) return false;
  // 鍵は「ロット|工程」(工程 id はテンプレをまたぐと同じ字が在り得る)
  const a = cfg.autoSteps[`${String(job.lotId)}|${String(job.stepId)}`]; if (!isObj(a) || a.mayLeave !== true || !(Number(a.finishWorkMin) > 0)) return false;
  if (job.parallelLabFinish) return false;
  // 🧪 待機の土俵(holdWorker): 人は離れない。終了対応は自動の直後に同じ人が続けて行う(=仕事の終わりを終了対応の分だけ延ばす)。
  //   設備も人もその間 塞がる(応援案と同じ 終了対応・設備の押さえ を持ち、違いは「人が離れるか」だけになる)
  const holdWorker = cfg.holdWorker === true;
  // 🚨 第三者(2026-09-23)③: 緊急ロットは「離れない」(既定)なら解放しない(終了対応は同じ人が直後に=待機と同じ形)
  const lotA0 = state.lotById.get(job.lotId);
  const urgentKeep = !holdWorker && cfg.urgentPolicy !== 'returnable' && !!lotA0 && lotA0.priorityClass === PRIORITY_CLASS.URGENT;
  if (urgentKeep) state.parallelLabStats.urgentKept += 1;
  if (holdWorker || urgentKeep) {
    const extra = Number(a.finishWorkMin) * 60000;
    running.endMs += extra; running.rec.endMs += extra; state.endMsByJob.set(job.jobId, running.endMs);
    state.parallelLabStats.finishJobs += 1;
    if (cfg.equipmentHold !== 'autoEnd') state.parallelLabStats.equipmentHeldMs += extra;
    return true;
  }
  state.holderOf.delete(picked); state.parallelLabStats.released += 1;
  const finId = `${job.jobId}#finish`;
  const fin = { ...job, jobId: finId, durationMs: Number(a.finishWorkMin) * 60000, durationKnown: true, afterJobId: job.jobId, requiredWorker: picked, parallelLabFinish: true, equipmentId: null, capEquipmentId: null };
  for (const j of (state.jobsByLot.get(job.lotId) || [])) if (j !== job && j.afterJobId === job.jobId) j.afterJobId = finId;
  const list = state.jobsByLot.get(job.lotId); if (list) list.push(fin);
  state.pendingJobs.push(fin);
  state.parallelLabStats.finishJobs += 1;
  running.parallelLabReleased = true;
  // 🔧 設備の解放時点(第三者 2026-09-23): 既定は「終了対応が済むまで」(品物が載ったまま)。'autoEnd' だけ自動の終わりで空く
  if (cfg.equipmentHold !== 'autoEnd') running.parallelLabHoldUntil = finId;
  // 🚶 離れている印(往復はこの間の移動だけ数える)。起点はロットAの場所
  const aLot = state.lotById.get(job.lotId);
  const aZone = aLot ? String(aLot.mapZoneId || '') : '';
  state.awayOf.set(picked, { finId, autoEndMs: running.endMs, aZone, aLotId: job.lotId });
  state.movedWhileAway.delete(picked);
  state.lastZoneOf.set(picked, aZone);
  return true;
}
/* 🧪 前の仕事の場所と違えば 登録した片道(分)を足す。登録が無ければ 0 で数える(推測しない)。 */
function parallelLabTravel(state, job, picked) {
  const cfg = state.parallelLab; if (!cfg || !state.awayOf.has(picked)) return null;   // 離れている人の移動だけ
  if (job.parallelLabFinish) {
    if (!state.movedWhileAway.has(picked)) return null;        // 動いていない人の「帰り」は往復なし
    // 帰りは最後の仕事が終わった直後に始めている(手が空いたら戻る)。まだ道の途中ならその残りだけ待つ
    const ret = state.awayReturnAtOf.get(picked); if (!ret) return null;
    return { zone: state.awayOf.get(picked).aZone, known: ret.known, zoneUnknown: ret.zoneUnknown, ms: Math.max(0, ret.atMs - state.now) };
  }
  const lot = state.lotById.get(job.lotId); const zone = lot ? String(lot.mapZoneId || '') : '';
  const prev = state.lastZoneOf.get(picked) || '';
  // 🚨 第三者(2026-09-23)③: 場所そのものが未登録なら「移動 0分」ではなく「足せない移動」として数える(推測しない)
  if (!zone || !prev) return { zone: zone || prev, known: false, zoneUnknown: true, ms: 0 };
  if (zone === prev) return null;
  const key = [prev, zone].sort().join('|');
  const min = cfg.travelMin && Number.isFinite(Number(cfg.travelMin[key])) && cfg.travelMin[key] !== null && cfg.travelMin[key] !== '' ? Number(cfg.travelMin[key]) : null;
  return { zone, known: min != null, ms: min == null ? 0 : min * 60000 };
}
/* 🚶 帰り(その仕事の場所 → ロットAの場所)の片道。登録が無ければ 0(推測しない。未登録は行きで数えている)。 */
function parallelLabBack(state, job, away) {
  const cfg = state.parallelLab; const lot = state.lotById.get(job.lotId); const zone = lot ? String(lot.mapZoneId || '') : '';
  if (!zone || !away.aZone) return { ms: 0, known: false, zoneUnknown: true };
  if (zone === away.aZone) return { ms: 0, known: true, zoneUnknown: false };
  const key = [zone, away.aZone].sort().join('|');
  const min = cfg.travelMin && Number.isFinite(Number(cfg.travelMin[key])) && cfg.travelMin[key] !== null && cfg.travelMin[key] !== '' ? Number(cfg.travelMin[key]) : null;
  return { ms: min == null ? 0 : min * 60000, known: min != null, zoneUnknown: false };
}
/* 🔧 設備だけ返す(人・区画は releaseHolders)。終了対応が済むまで押さえる時はそこから呼ぶ。 */
function releaseEquipmentOf(state, rec) {
  if (rec.equipmentId != null && state.busyEquipment.get(rec.equipmentId) === rec.jobId) {
    state.busyEquipment.delete(rec.equipmentId);
  }
  // 🔧 設備は「台数」。区画と同じで、自分が足した台数だけ引く。
  //   ⚠ 引き忘れると設備が永久に満杯になり、盤が途中で止まったように見える。
  if (rec.capEquipmentId != null && rec.equipmentHeads > 0) {
    const left = (state.equipmentUsed.get(rec.capEquipmentId) || 0) - rec.equipmentHeads;
    if (left > 0) state.equipmentUsed.set(rec.capEquipmentId, left);
    else state.equipmentUsed.delete(rec.capEquipmentId);
  }
}

function releaseHolders(state, rec) {
  if (state.holderOf.get(rec.worker) === rec.jobId) state.holderOf.delete(rec.worker);
  if (rec.partner && state.holderOf.get(rec.partner) === rec.jobId) state.holderOf.delete(rec.partner);
  // 🧪 parallelLab: 終了対応が済むまで設備を押さえる(品物が載ったまま)。済んだ時にまとめて空ける
  if (rec.parallelLabHoldUntil) state.parallelLabHeld.set(rec.parallelLabHoldUntil, rec);
  else releaseEquipmentOf(state, rec);
  if (state.parallelLabHeld && state.parallelLabHeld.has(rec.jobId)) {
    const held = state.parallelLabHeld.get(rec.jobId); state.parallelLabHeld.delete(rec.jobId);
    held.parallelLabHoldUntil = null;
    state.parallelLabStats.equipmentHeldMs += Math.max(0, rec.endMs - held.endMs);
    releaseEquipmentOf(state, held);
  }
  // 🏭 区画は「人数」なので、**自分が足した頭数だけ** 引く(0未満にしない・鍵は0で消す)。
  //   ⚠ 引き忘れると区画が永久に満杯になり、盤が途中で止まったように見える。
  if (rec.zoneId != null && rec.zoneHeads > 0) {
    const left = (state.zoneUsed.get(rec.zoneId) || 0) - rec.zoneHeads;
    if (left > 0) state.zoneUsed.set(rec.zoneId, left);
    else state.zoneUsed.delete(rec.zoneId);
  }
}

// ----------------------------------------------------------------------------
// 2. もう進められない持ち出しを戻す
// ----------------------------------------------------------------------------
/**
 * 休暇が始まった等で、その人がこの期間中もう1分も働けなくなった作業を、手元に抱えたままにしない。
 * 抱えたままだと、その仕事は誰にも回らず「理由の分からない止まり方」になる。
 *
 * 🚨 戻すのは **まだ1分も進んでいない** 物だけ。
 *   途中まで進んだ作業を戻すと、その人が実際に働いた時間が消えて、
 *   結果が実際より悪い方へ嘘をつく(Job は途中の残りを持てない形なので分割もできない)。
 */
function releaseUnavailableAssignments(state) {
  if (state.running.size === 0) return;
  const cal = state.calendar;
  const back = [];
  for (const [jobId, rec] of state.running) {
    if (rec.endMs <= state.horizonEnd) continue;               // 期間内に終わる見込み
    if (cal.workMsBetween(rec.startMs, state.now, rec.worker) > 0) continue; // もう進んでいる
    if (cal.workMsBetween(state.now, state.horizonEnd, rec.worker) > 0) continue; // まだ働ける
    back.push(jobId);
  }
  for (const jobId of back) {
    const rec = state.running.get(jobId);
    state.running.delete(jobId);
    state.endMsByJob.delete(jobId);
    state.recordByJob.delete(jobId);
    // 🚨 戻した仕事は「まだ手が付いていない」へ戻す。
    //   以前はここで戻さず、毎ラウンド state.jobs から全部作り直す事で辻褄を合わせていた。
    //   その作り直しが1回 O(全部の仕事) で、本番282ロット(仕事1258件)×約1000ラウンド= 126万回。
    if (!state.pendingJobs.some((j) => j.jobId === jobId)) state.pendingJobs.push(rec.job);
    releaseHolders(state, rec);
    const at = state.assignments.indexOf(rec.rec);
    if (at >= 0) state.assignments.splice(at, 1);
    state.audit.push({
      atMs: state.now,
      kind: 'release',
      jobId,
      lotId: rec.job.lotId,
      worker: rec.worker,
      reason: 'この期間はもう働ける時間が無いため、手元から戻しました',
    });
  }
}

// ----------------------------------------------------------------------------
// 3. いま始められる仕事を並べる
// ----------------------------------------------------------------------------
function buildRunnableTasks(state) {
  // まだ手が付いていない仕事。priority.reserveSpecialist がこの配列を見る。
  // 🚨 ここで毎回 state.jobs から作り直さない。配った時に外し(assign)、戻した時に足す
  //   (releaseUnavailableAssignments)ので、この配列は既に正しい。作り直すと1ラウンドごとに
  //   全部の仕事をなめて新しい配列を作る事になり、本番で数秒ぶんの差が出る。
  //   ⚠ 万一ズレたら結果が変わるので、ズレていない事を試験で固定する(S26)。
  // 🚨 2026-09-04（案A の②）: 「技能の範囲の広さ」と「ロットの関所」は、どちらも
  //   state.pendingJobs を頭から終わりまでなめるだけの物だった。**2周を1周にする**。
  //   出す物（state.breadth / state.lotGate）は1ビットも変えていない。
  computeBreadthAndLotGate(state);

  if (state.scenario.checkPendingInvariant) {
    // 試験用。本番では回さない(O(全部の仕事)なので)。
    const want = state.jobs.filter((j) => !state.doneJobIds.has(j.jobId) && !state.endMsByJob.has(j.jobId));
    const a = new Set(state.pendingJobs.map((j) => j.jobId));
    const b = new Set(want.map((j) => j.jobId));
    if (a.size !== b.size || [...b].some((id) => !a.has(id))) {
      throw new Error(`simulate: まだ手が付いていない仕事の一覧がズレました(持っている ${a.size}件 / 本来 ${b.size}件)`);
    }
  }

  const runnable = state.pendingJobs.filter((j) => isJobReady(state, j) && j.durationKnown !== false && finite(j.durationMs) != null);
  state.heldJobIds = new Set();   // 🧷 待たせた仕事は回ごとに数え直す
  // 🚨 priority.reserveSpecialist に「本当に今配れる仕事か」を渡すため。
  //   readyNow(前工程・到着) だけでは足りない。目標時間が無い仕事は前工程を塞いだまま
  //   ずっと ready のように見え、熟練者が **永久に来ない物** を待つ(実測: 16分の空き)。
  state.runnableJobIds = new Set(runnable.map((j) => j.jobId));
  if (runnable.length <= 1) return runnable;

  // 指示書5.5 の1〜10。並べ方は priority.js に閉じ込めてある。
  const ctx = roundCtx(state, undefined);
  return runnable.sort((a, b) => compareJobs(a, b, ctx));
}

/**
 * ロットに1回だけの工程(段取り・員数・荷姿など)の関所。
 * buildJobs.js の但し書き: afterJobId 1本では「前の通常工程 × 全台」を表せないので、
 * 「同じロットで、まだ残っている台ごとの工程の一番小さい工程順」を毎回数え直す。
 */
/**
 * 🚨 2026-09-04（案A の②）: 上の「関所」と下の「技能の範囲の広さ」は、どちらも
 *   state.pendingJobs を頭から終わりまでなめるだけだった。**1周にまとめる**。
 *   ・出す物は前と同じ2つ（state.lotGate / state.breadth）。式は1文字も変えていない。
 *   ・工程ごとの数え方（同じ工程は1回だけ数える）も、関所の取り方（一番小さい工程順）も
 *     元のまま。順番に依らない Map なので、1周にしても答えは同じ。
 *   ⚠ 「答えが変わっていない」事は md5 で確かめる（1か月ぶんの計算結果まるごと）。
 */
function computeBreadthAndLotGate(state) {
  const gate = new Map();
  const breadth = new Map();
  const seenProcess = new Set();
  for (const j of state.pendingJobs) {
    // ① 技能の範囲の広さ（工程は1回だけ数える）
    const key = String(j.processKey ?? '');
    if (!seenProcess.has(key)) {
      seenProcess.add(key);
      for (const n of eligibleOf(state, key).names) breadth.set(n, (breadth.get(n) || 0) + 1);
    }
    // ② ロットの関所（台ごとの工程のうち、一番小さい工程順）
    if (j.unitIndex === null || j.unitIndex === undefined) continue;
    const n = finite(j.stepIndex);
    if (n == null) continue;
    const cur = gate.get(j.lotId);
    if (cur == null || n < cur) gate.set(j.lotId, n);
  }
  // 進行中の台の作業も「まだ終わっていない」。関所はその後ろ。
  for (const rec of state.running.values()) {
    const j = rec.job;
    if (j.unitIndex === null || j.unitIndex === undefined) continue;
    const n = finite(j.stepIndex);
    if (n == null) continue;
    const cur = gate.get(j.lotId);
    if (cur == null || n < cur) gate.set(j.lotId, n);
  }
  state.lotGate = gate;
  state.breadth = breadth;
}

function isJobReady(state, job) {
  // 🚨 未入荷のロットに、到着より前の開始時刻を置かない。
  const arrival = finite(job.arrivalMs);
  if (arrival == null) return false;      // 到着が分からない物は置かない(unresolved へ回す)
  if (arrival > state.now) return false;
  if (job.afterJobId && !state.doneJobIds.has(job.afterJobId)) return false;
  if (job.unitIndex === null || job.unitIndex === undefined) {
    const gate = state.lotGate ? state.lotGate.get(job.lotId) : null;
    const n = finite(job.stepIndex);
    if (gate != null && n != null && gate < n) return false;
  }
  return true;
}

/* 🚨 2026-09-04: 「技能の範囲の広さ」の数え方（残っている仕事の工程のうち、その人を
 *   候補に挙げている工程の数。指示書5.5-7「共通作業は、担当できる技能の範囲が狭い人から」）は
 *   computeBreadthAndLotGate の ① へ **そのまま移した**（式は1文字も変えていない）。
 *   ⚠ 工程マスタ全体ではなく **残っている仕事** で数える、も同じ。
 *   写しを作らないので、ここには関数を残さない。 */

function eligibleOf(state, processKey) {
  const key = String(processKey ?? '');
  let hit = state.eligCache.get(key);
  if (hit) return hit;
  const raw = state.eligibility.eligibleFor(key);
  const list = Array.isArray(raw) ? raw : [];
  const names = [];
  const evidence = new Map();
  for (const c of list) {
    const name = trimmedName(c);
    if (!name || evidence.has(name)) continue;
    names.push(name);
    evidence.set(name, typeof c === 'string' ? EVIDENCE.UNKNOWN : String(c?.evidence ?? EVIDENCE.UNKNOWN));
  }
  hit = { names, evidence };
  state.eligCache.set(key, hit);
  return hit;
}

const isWorkerFree = (state, name) => (
  !state.holderOf.has(name) && state.calendar.isAvailable(state.now, name)
  // ⏳ 設定「続きが前工程待ちの時: N分までなら待つ」で手を空けて待っている間(holdUntil)は空きと見ない
  && !(state.holdUntil && (state.holdUntil.get(name) || 0) > state.now)
);

/**
 * ⏳ 設定 lotWaitMinutes(opsimRules): 持っているロットの続きが **作業中の前工程** の完了待ちで、その完了が N分以内なら
 *   別のロットへ移らず手を空けて待つ(holdUntil)。N を超える・前工程が作業中でない(到着待ち等)なら今までどおり移る。
 * 🚨 scenario に無ければ1行も動かない(既定は今までの計算と同じ)。
 */
export function holdForLotContinuation(state, p, decisions) {   // export は見張り(RL-3)の為
  const waitMs = (Number(state.scenario && state.scenario.lotWaitMinutes) || 0) * 60000;
  if (waitMs <= 0) return false;
  let readyAt = null;
  for (const j of (state.jobsByLot.get(p.lotId) || [])) {
    if (state.doneJobIds.has(j.jobId) || state.endMsByJob.has(j.jobId) || !j.afterJobId) continue;
    const r = state.running.get(j.afterJobId);
    if (!r || !(r.endMs > state.now)) continue;
    if (readyAt == null || r.endMs < readyAt) readyAt = r.endMs;
  }
  if (readyAt == null || readyAt - state.now > waitMs) return false;
  if (!state.holdUntil) state.holdUntil = new Map();
  state.holdUntil.set(p.name, readyAt);
  if (Array.isArray(decisions)) {
    decisions.push({ atMs: state.now, kind: 'wait-lot', lotId: p.lotId, worker: p.name,
      reason: `${p.name}さんは持っているロットの前工程が終わるのを待っています（あと${Math.max(1, Math.round((readyAt - state.now) / 60000))}分・設定「続きが前工程待ちの時」）` });
  }
  return true;
}

/**
 * priority.js へ渡す文脈。
 * ⚠ 重い読み取り(候補・空き・技能の範囲・工程順)は全部こちらの関数を渡す。
 *   priority 側が自前で数え直すと、同じ事を2回やる事になる(500件で効く)。
 */
function roundCtx(state, workerName) {
  // 🚨 priority.js は ctx オブジェクトそのものを鍵にして索引を使い回す(CTX_CACHE)。
  //   ここで毎回 new すると、その仕組みが **1度も当たらず**、残っている全部の仕事を
  //   人ごと・呼ばれるたびに数え直す。実測(2026-08-22 本番282ロット・5日): 26秒。
  //   同じ時刻の間は同じオブジェクトを返す。時刻が動いたら捨てる。
  if (state.ctxCacheAt !== state.now) { state.ctxCache = new Map(); state.ctxCacheAt = state.now; }
  const ck = String(workerName ?? '');
  const hit = state.ctxCache.get(ck);
  if (hit) return hit;
  const built = {
    atMs: state.now,
    calendar: state.calendar,
    pendingJobs: state.pendingJobs,
    lotById: state.lotById,
    workerName,
    eligibleNamesOf: (job) => eligibleOf(state, job?.processKey).names,
    // 今このラウンドで実際に配れる仕事か(目標時間あり・前工程済み・到着済み)。
    isRunnableNow: (job) => (state.runnableJobIds ? state.runnableJobIds.has(job?.jobId) : null),
    isReady: (job) => isJobReady(state, job),
    isFree: (name) => isWorkerFree(state, name),
    isEquipmentFree: (eq) => !state.busyEquipment.has(eq),
    breadthOf: (name) => state.breadth.get(name) ?? 0,
    currentJobIdOf: (name) => state.holderOf.get(name) ?? null,
    busyUntilOf: (name) => {
      const id = state.holderOf.get(name);
      return id == null ? null : (state.endMsByJob.get(id) ?? null);
    },
    // 🚨 持ち替えのしきい値は直書きしない。渡されなければ持ち替えない(指示書5.6)。
    switchGainThresholdMs: state.scenario.switchGainThresholdMs,
    safetyFactor: state.scenario.safetyFactor,
    // 🧵 優先度の区分を 0番目の鍵にするか。立っていなければ priority.js の並びは今までと同じ。
    priorityClass: state.priorityClassOn,
  };
  state.ctxCache.set(ck, built);
  return built;
}

// ----------------------------------------------------------------------------
// 4. 手の空いた人へ、順番に配る
// ----------------------------------------------------------------------------
/**
 * 🚨 外側の回し方を「人」ではなく **「仕事」** にしてある。
 *   人を外側にすると、名簿の並び順で結果が変わる。
 *   (例: 一般作業しかできない人が先に回ると、その人が別の仕事を取ってしまい、
 *    後から回ってきた熟練者が一般作業を持つ羽目になる)
 *   指示書5.5 は「配置は次の順で比較する」= 仕事の順で配ると書いてある。
 */
function assignAllIdleWorkers({ state, runnable }) {
  const decisions = [];
  // 🧵 ロットは持ったら最後まで: 全体の並びから配る **前に**、空いた人へ「いま持っているロットの続き」を配る。
  //   🚨 lotFocus が切ってある(既定)間は continuePass を呼びもしない = いままでと1バイト同じ。
  //   ⚠ 続きで渡した仕事は endMsByJob に載るので、下の assignPass は同じ仕事を二重に配らない。
  const cont = state.lotFocus ? continuePass(state, runnable, false, decisions) : { assigned: 0, reservedOnly: false };
  const first = assignPass(state, runnable, false, decisions);
  // 温存(指示書5.6)だけを理由に誰も動かなかった時は、温存をやめてもう一度配る。
  // そうしないと「適格な仕事があるのに全員が手を止める」(S02違反)を自分で作る。
  if (cont.assigned + first.assigned === 0 && (first.reservedOnly || cont.reservedOnly)) {
    if (state.lotFocus) continuePass(state, runnable, true, decisions);
    assignPass(state, runnable, true, decisions);
  }
  return decisions;
}

/**
 * 🧵 続きの配り(2026-09-10 清水さん「ロット処理して次のロットでいいでしょ」)。
 *
 * 空いた人ごとに、まず **その人がいま持っているロット**(直前に割り付けた仕事のロット)の中で
 * いま手を付けられる仕事(runnable・その人が候補・設備/区画/分担/温存の門を通る)を渡す。
 * そのロットに1つも無ければ何もしない(後の assignPass が全体の並びから渡す = 次のロットへ。
 * その時の理由は noteLotSwitch が残す)。
 *
 * 🚨 例外は1つだけ: いま持っているロットより **優先度の区分が高い**(緊急>特注>通常)ロットの仕事が
 *   runnable で、その人が候補なら 続きを配らず全体の並びへ譲る(＝そちらへ移る)。
 *   区分が同じなら、納期が近くても移らない(ロットを終える)。
 *   ⚠ scenario.priorityClass が立っていない時は区分を見ない(例外は起きない)。
 * 🚨 tryAssign をそのまま使う(設備・区画・分担・温存の門を素通りしない)。渡す人を1人に絞るだけ。
 * 🚨 人の順は 名簿の順ではなく **いま持っている仕事の開始が早い人から**、同じなら名前順(S23)。
 */
function continuePass(state, runnable, allowReserved, decisions) {
  let assigned = 0;
  let reservedOnly = false;
  if (!allowReserved) state.continueTried = new Map();

  // 空いていて、いま持っているロットが在る人。開始の早い順 → 名前順。
  const people = [];
  for (const name of state.workerNames) {
    if (!isWorkerFree(state, name)) continue;
    const lotId = state.currentLotOf.get(name);
    if (lotId == null) continue;
    people.push({ name, lotId, startMs: state.lastStartOf.get(name) ?? 0 });
  }
  if (people.length === 0) return { assigned, reservedOnly };
  people.sort((a, b) => (a.startMs - b.startMs) || cmpId(a.name, b.name));

  // runnable(全体の並び。compareJobs 順)をロットごとに束ねる。並びは崩さない。
  const byLot = new Map();
  for (const job of runnable) {
    let list = byLot.get(job.lotId);
    if (!list) { list = []; byLot.set(job.lotId, list); }
    list.push(job);
  }

  for (const p of people) {
    if (!isWorkerFree(state, p.name)) continue;   // この回で相方として取られた等
    const mine = byLot.get(p.lotId);
    if (!mine || mine.length === 0) { holdForLotContinuation(state, p, decisions); continue; }      // 続きは無い(理由は noteLotSwitch が数える)／前工程待ちなら設定次第で待つ

    // 🚨 例外: もっと区分の高いロットの仕事が runnable で、この人が候補なら 続きを配らない。
    //   ⚙ 設定 priorityPreempt='orderOnly'(opsimRules): 区分は「次に取る順番」だけに効かせ、持っているロットは最後までやる
    if (state.priorityClassOn && (state.scenario && state.scenario.priorityPreempt) !== 'orderOnly' && higherClassRunnableFor(state, runnable, p.name, p.lotId)) continue;

    let tried = state.continueTried.get(p.name);
    if (!tried) { tried = new Set(); state.continueTried.set(p.name, tried); }
    let got = false;
    for (const job of mine) {
      if (state.endMsByJob.has(job.jobId)) continue;   // この回で誰かが取った
      const outcome = tryAssign(state, job, allowReserved, decisions, p.name);
      if (outcome === 'assigned') { assigned += 1; got = true; break; }
      if (outcome === 'reserved') reservedOnly = true;
      tried.add(waitKeyOfOutcome(outcome));
    }
    if (!got) holdForLotContinuation(state, p, decisions);
  }
  return { assigned, reservedOnly };
}

/**
 * 🧵 いま持っているロットより区分の高いロットの仕事が、まだ誰も取っておらず runnable で、
 *   この人がその工程の候補に入っているか。
 * ⚠ runnable は compareJobs 順(区分が0番目の鍵)なので、区分が並ぶ順に見て 自分の区分に届いたら止める。
 */
function higherClassRunnableFor(state, runnable, name, lotId) {
  const cur = state.lotById.get(lotId);
  const myClass = priorityClassRank(cur ? cur.priorityClass : null);
  for (const job of runnable) {
    const cls = priorityClassRank(job.priorityClass);
    if (cls >= myClass) return false;
    if (job.lotId === lotId) continue;
    if (state.endMsByJob.has(job.jobId)) continue;
    if (eligibleOf(state, job.processKey).names.includes(name)) return true;
  }
  return false;
}

/**
 * 🧵 人がロットを離れた(次の仕事が別のロットだった)時に、**なぜ離れたか** を残す。
 * 🚨 lotFocus が立っている時だけ呼ばれる(切ってある時は結果の形を1バイトも変えない)。
 * 🚨 文は lotFocus.js の lotSwitchWhy ただ1本。ここでは材料(種類と内訳)だけ数える。
 * 🚨 分からない事は書かない。ただし why は空にしない(種類が読めなければ「次のロットへ」とだけ言う)。
 */
function noteLotSwitch(state, name, fromLotId, job, atMs) {
  const toLotId = job.lotId;
  const fromLot = state.lotById.get(fromLotId) || null;
  const toLot = state.lotById.get(toLotId) || null;
  const fromClass = priorityClassRank(fromLot ? fromLot.priorityClass : null);
  const toClass = priorityClassRank(toLot ? toLot.priorityClass : null);

  let kind;
  let waits = [];
  // 離れたロットに、まだ手が付いていない仕事が残っているか。
  //   🚨 2026-09-22: 先に数える。全部終わってから緊急へ行った物を「一旦置いて」と言わない(orderOnly の設定で嘘の文が出ていた)
  let pending = 0;
  let running = 0;
  const waitSet = new Set(state.continueTried.get(name) || []);
  for (const j of (state.jobsByLot.get(fromLotId) || [])) {
    if (state.doneJobIds.has(j.jobId)) continue;
    if (state.endMsByJob.has(j.jobId)) { running += 1; continue; }
    pending += 1;
    // まだ runnable でない仕事は、なぜ待っているか(isJobReady と同じ見方)。
    if (j.durationKnown === false || finite(j.durationMs) == null) waitSet.add(LOT_WAIT.DURATION);
    else if (finite(j.arrivalMs) == null || finite(j.arrivalMs) > atMs) waitSet.add(LOT_WAIT.ARRIVAL);
    else if (!isJobReady(state, j)) waitSet.add(LOT_WAIT.PREV_STEP);
    else if (state.pins.has(j.lotId) && state.pins.get(j.lotId) !== name) waitSet.add(LOT_WAIT.PINNED);
    else if (!eligibleOf(state, j.processKey).names.includes(name)) waitSet.add(LOT_WAIT.NO_RECORD);
  }
  if (pending === 0) kind = running > 0 ? LOT_SWITCH_KIND.OTHERS_WORKING : LOT_SWITCH_KIND.LOT_DONE;
  else if (state.priorityClassOn && toClass < fromClass) kind = LOT_SWITCH_KIND.HIGHER_CLASS;
  else { kind = LOT_SWITCH_KIND.WAITING; waits = [...waitSet]; }

  const why = lotSwitchWhy({
    fromLabel: lotLabelOf(fromLot, fromLotId),
    toLabel: lotLabelOf(toLot, toLotId),
    kind,
    waits,
    toClass,
  });
  let list = state.lotSwitches.get(fromLotId);
  if (!list) { list = []; state.lotSwitches.set(fromLotId, list); }
  list.push({ atMs, worker: name, fromLotId, toLotId, why, kind });
}

function assignPass(state, runnable, allowReserved, decisions) {
  let assigned = 0;
  let reservedOnly = false;
  for (const job of runnable) {
    if (state.endMsByJob.has(job.jobId)) continue;   // この回で誰かが取った
    if (countFreeWorkers(state) === 0) break;        // もう手が空いている人が居ない
    const outcome = tryAssign(state, job, allowReserved, decisions);
    if (outcome === 'assigned') assigned += 1;
    else if (outcome === 'reserved') reservedOnly = true;
  }
  return { assigned, reservedOnly };
}

function countFreeWorkers(state) {
  let n = 0;
  for (const name of state.workerNames) if (isWorkerFree(state, name)) n += 1;
  return n;
}

/**
 * @param {string|null} [only] 🧵 この人にだけ渡す(continuePass)。null なら今までどおり候補から選ぶ。
 *   🚨 門(設備・区画・分担・温存・OJT・2人)は only でも **全部そのまま** 通す。絞るのは最後の「誰に」だけ。
 */
/** 🧵 このロットに もう手が付いているか(現場で進んでいる doneTaskKeys／この回で割り付いた・終えた仕事)。 */
function lotStartedOf(state, lotId) {
  const lot = state.lotById.get(lotId);
  if (lot && Array.isArray(lot.doneTaskKeys) && lot.doneTaskKeys.length > 0) return true;
  for (const j of (state.jobsByLot.get(lotId) || [])) {
    if (state.endMsByJob.has(j.jobId) || state.doneJobIds.has(j.jobId)) return true;
  }
  return false;
}

/**
 * 🧵 出来る人(名簿に居る候補)が1人も居ない工程。無ければ null。ロットごとに1回だけ数えて覚える。
 *   見つけたら 理由の文(blockedDetail)も同時に残す。工程の名前は仕事が持つ物をそのまま。
 */
function unfinishableStepOf(state, lotId) {
  if (!state.unfinishableByLot) state.unfinishableByLot = new Map();
  if (state.unfinishableByLot.has(lotId)) return state.unfinishableByLot.get(lotId);
  let gap = null;
  for (const j of (state.jobsByLot.get(lotId) || [])) {
    const names = eligibleOf(state, j.processKey).names.filter((n) => state.rosterSet.has(n));
    if (names.length === 0) { gap = j; break; }
  }
  state.unfinishableByLot.set(lotId, gap);
  if (gap) {
    if (!state.unfinishableDetail) state.unfinishableDetail = new Map();
    const titles = state.stepTitleByLot ? state.stepTitleByLot.get(lotId) : null;
    const label = (titles && titles.get(Number(gap.stepIndex))) || gap.title || gap.stepTitle || gap.processKey || '工程';
    state.unfinishableDetail.set(lotId, `「${label}」を出来る人が居ないので、このロットは始めません（始めたら最後まで）`);
  }
  return gap;
}

function tryAssign(state, job, allowReserved, decisions, only = null) {
  const planLock = lockOf(job, state.planJobLocks);
  if (planLock) {
    if (only != null && only !== planLock.worker) return 'pinned-other';
    only = planLock.worker;
  }
  // ── 設備(S10) ────────────────────────────────────────────────────────────
  // 🚨 設備が同時に2件を処理する事を許さない。
  // 🔧 上限を決めた設備(equipmentCap に在る id)は下の台数の門が数える。ここは上限の無い id だけ。
  const eq = (job.equipmentId === '' || job.equipmentId === undefined) ? null : job.equipmentId;
  const exclusiveEq = (eq != null && !state.equipmentCap.has(String(eq))) ? eq : null;
  if (exclusiveEq != null && state.busyEquipment.has(exclusiveEq)) {
    if (!state.equipmentWaitSeen.has(job.jobId)) {
      state.equipmentWaitSeen.add(job.jobId);
      decisions.push({
        atMs: state.now,
        kind: 'wait-equipment',
        jobId: job.jobId,
        lotId: job.lotId,
        equipmentId: eq,
        reason: IDLE_REASON.EQUIPMENT,
      });
    }
    return 'equipment';
  }

  // ── 🏭 作業する区画(場所)の定員 ────────────────────────────────────────────
  // 清水さん(2026-09-06)「作業している場所が被ってる人いたわ」。設備の門と同じ形。
  // 🚨 分からない物は塞がない: 区画が決まっていない(null / zone_unassigned)ロットと、
  //   定員を決めていない区画は **素通り**。過去の実績が無い区画に「1人」と決めつけない。
  const zid = (job.zoneId === '' || job.zoneId === undefined || job.zoneId === 'zone_unassigned') ? null : job.zoneId;
  const zoneCap = zid == null ? null : (state.zoneCapacity.get(zid) ?? null);
  if (zoneCap != null && (state.zoneUsed.get(zid) || 0) >= zoneCap) {
    if (!state.zoneWaitSeen.has(job.jobId)) {
      state.zoneWaitSeen.add(job.jobId);
      decisions.push({
        atMs: state.now,
        kind: 'wait-zone',
        jobId: job.jobId,
        lotId: job.lotId,
        zoneId: zid,
        reason: `${IDLE_REASON.ZONE_FULL}（${state.zoneName ? (state.zoneName.get(zid) || zid) : zid} は同時 ${zoneCap}人まで）`,
      });
    }
    return 'zone-full';
  }

  // ── 🔧 設備(治具・測定機)の台数 ────────────────────────────────────────────
  // 区画の門と **同じ形**。塞いだら必ず理由を残す(理由を言えない門は作らない)。
  // 🚨 分からない物は塞がない: 設備の索引に無い工程・上限を決めていない設備は素通り。
  //   索引は「上限を決めた設備」だけを持つ(上を見よ)ので、
  //   equipmentGate が塞ぐのは 人が上限を決めた設備だけ。
  // 🚨 上の busyEquipment の門(S10・上限の無い設備)とは **別の物**(1件ずつ vs 何台まで)。
  // 🔧 id は仕事に付いた物(job.equipmentId)が先、無ければ工程キーの索引。
  // 🧪 parallelLab: 終了対応(#finish)は載っている品物の続きなので、自動の仕事が押さえている設備がそれ(門を通らない)
  const capEq = job.parallelLabFinish ? null : ((eq != null && state.equipmentCap.has(String(eq)))
    ? String(eq) : (state.equipmentOfStep.get(String(job.processKey ?? '')) ?? null));
  if (capEq != null) {
    const g = equipmentGate({
      job: { equipmentId: capEq, jobId: job.jobId, lotId: job.lotId },
      holders: state.equipmentUsed,
      capacity: state.equipmentCap,
    });
    if (!g.ok) {
      if (!state.equipmentFullSeen.has(job.jobId)) {
        state.equipmentFullSeen.add(job.jobId);
        // ⚠ 文は equipmentCapacity.js が作った物をそのまま出す(ここで書き直さない)。
        decisions.push({
          atMs: state.now,
          kind: g.reason.kind,
          jobId: job.jobId,
          lotId: job.lotId,
          equipmentId: g.reason.equipmentId,
          reason: g.reason.text,
        });
      }
      return 'equipment-full';
    }
  }

  const { names, evidence } = eligibleOf(state, job.processKey);
  if (names.length === 0) return 'no-candidate';
  // 🧵 2026-09-17 「始めたら最後まで」(清水さん): まだ手を付けていないロットは、残りの工程ぜんぶに
  //   出来る人が居る時だけ始める。出来る人が居ない工程が1つでも在れば **最初の工程にも手を付けない**。
  //   実測(2026-09-17 写し): RTT-215,AB 1001554555 が最初の「準備」を3分だけやって「制御装置用意」で止まり、
  //   納期一覧に 3分の棒と赤い納期線だけが残っていた(始めたのに終われない＝決まり違反)。
  //   🚨 lotFocus が切ってある間は1行も動かない(結果の形を1バイトも変えない)。
  //   🚨 すでに手が付いているロット(現場で進んでいる doneTaskKeys／この回で割り付いた仕事)は対象外＝続きは今までどおり。
  //   🚨 能力の判定は eligibleOf ただ1本(能力は1ミリも変えない)。理由は lotResults.blockedDetail に残す(画面はそのまま出す)。
  if (state.lotFocus && !lotStartedOf(state, job.lotId) && unfinishableStepOf(state, job.lotId)) return 'unfinishable';
  // 📌 2026-09-15 手で決めた担当(清水さん「この画面で誰がするか変更したり、外したり」)。
  //   '' = この期間は誰にも当てない。名前 = その人にだけ渡す(候補に居なければ渡らない＝能力は1ミリも変えない)。
  //   🚨 続きの配り(only)と食い違う時は固定が勝つ。設備・区画の門はこの上で既に通っている。
  if (state.pins.has(job.lotId)) {
    const pinned = state.pins.get(job.lotId);
    if (pinned === '') return 'pinned-none';
    if (only != null && only !== pinned) return 'pinned-other';
    only = pinned;
  }
  // 📌 2026-09-19 やわらかい固定(記録の実際の担当)。その人が この工程の候補に居て名簿に居る時だけ絞る。
  //   居なければ **何もしない**(今までどおり候補から選ぶ)＝「固定した担当に記録が無い」でロットを止めない。
  let fromSoftPin = false;
  if (!planLock && !state.pins.has(job.lotId) && state.softPins.has(job.lotId)) {
    const soft = state.softPins.get(job.lotId);
    if (names.includes(soft) && state.rosterSet.has(soft)) {
      if (only != null && only !== soft) return 'pinned-other';
      if (only == null) { only = soft; fromSoftPin = true; }
    }
  }
  // 🧵 この人にだけ渡す時、その人がこの工程の候補に入っていなければ渡せない(能力は1ミリも変えない)。
  if (only != null && !names.includes(only)) return 'not-eligible';

  const free = names.filter((n) => state.rosterSet.has(n) && isWorkerFree(state, n));
  if (free.length === 0) return 'no-free';

  // ── 1つの型式は1人で（🚨 仮定。既定はOFF）────────────────────────────────
  // 意味は「同じ型式を **同時に** 2人が触らない」。
  // ⚠「最初に触った人が最後まで全部持つ」ではない（そちらは1型式に最大50ロット付くので
  //   1人へ丸ごと乗る）。どちらを指しているかは清水さんに要確認。
  let freeNow = free;
  if (state.oneWorkerPerModel) {
    const model = String(job.model ?? (state.lotById.get(job.lotId) || {}).model ?? '');
    if (model) {
      const holders = new Set();
      for (const r of state.running.values()) {
        const m = String(r.job.model ?? (state.lotById.get(r.job.lotId) || {}).model ?? '');
        if (m === model) { holders.add(r.worker); if (r.partner) holders.add(r.partner); }
      }
      if (holders.size > 0) {
        freeNow = free.filter((n) => holders.has(n));
        if (freeNow.length === 0) {
          // 🚨 黙って止めない。理由を必ず残す（理由の無い待機を作らない）。
          if (!state.modelLockSeen) state.modelLockSeen = new Set();
          if (!state.modelLockSeen.has(job.jobId)) {
            state.modelLockSeen.add(job.jobId);
            decisions.push({
              atMs: state.now, kind: 'wait-model-lock', jobId: job.jobId, lotId: job.lotId,
              reason: `1つの型式は1人で、という仮定のため待っています（${model} は他の人が持っています）`,
            });
          }
          return 'model-locked';
        }
      }
    }
  }

  // ── 👥 分担の区切り(1台は同じ人で) ───────────────────────────────────────
  // 清水さん(2026-09-10)「分担するときはできたら一台毎で区切る感じじゃないとだめだからね」。
  // 🚨 渡されなければ handoffGate が 'free' を返す = 顔ぶれも順番も1バイト変わらない。
  // 🚨 ここは「テンプレを優先」と同じ **順番と絞り込み** の層。**能力(eligibleOf)には混ぜない**。
  //   能力に混ぜると「その台を持っていないから頼めない」になり、出来ると分かっている人を外す。
  // 🚨 ロットに1回だけの工程(unitIndex が null)には門を掛けない(誰がやってもよい)。
  // ⚠ 持ち主がこの工程の候補に **そもそも入っていない** 時は門を掛けない。
  //   掛けると「前の工程をやった人はこの工程をやれない」台が永久に置けなくなる
  //   (止まった事も理由も残らないまま、そのロットだけ遅れる)。
  // ⚠ 2人でやる工程は 'unit' でも 'soft' へ落とす。1人へ絞ると相方が見つからず、
  //   「2人でできる工程」の指定と噛み合って永久に着手できない。
  const unitKey = unitKeyOf(job);
  const unitOwnerRaw = unitKey == null ? '' : (state.unitOwner.get(unitKey) || '');
  const unitOwner = (unitOwnerRaw && names.includes(unitOwnerRaw) && state.rosterSet.has(unitOwnerRaw))
    ? unitOwnerRaw : '';
  const handoffModeHere = (state.handoff === HANDOFF_MODE.UNIT
    && state.twoPersonProcessKeys.has(String(job.processKey ?? '')))
    ? HANDOFF_MODE.SOFT : state.handoff;
  const hg = handoffGate({ mode: handoffModeHere, owner: unitOwner, candidates: freeNow });
  if (hg.kind === 'wait') {
    // 🚨 黙って止めない。理由は handoff.js が作った物をそのまま出す(ここで書き直さない)。
    if (!state.handoffWaitSeen.has(job.jobId)) {
      state.handoffWaitSeen.add(job.jobId);
      decisions.push({
        atMs: state.now,
        kind: HANDOFF_WAIT_KIND,
        jobId: job.jobId,
        lotId: job.lotId,
        unitIndex: job.unitIndex,
        worker: hg.waitFor,
        reason: hg.reason,
      });
    }
    return 'unit-owner-busy';
  }
  // 'must' … その台を持っている人1人へ絞る('unit' で その人が空いている時)
  if (hg.kind === 'must') freeNow = freeNow.filter((n) => n === hg.only);
  // 🧵 この人にだけ渡す時、その台を持っているのが別の人なら渡せない(分担の区切りは今までどおり効く)。
  //   📌 やわらかい固定で絞った時は、その台の持ち主(分担の区切り)の方が勝つ＝絞りを外して今までどおり。
  if (only != null && hg.kind === 'must' && hg.only !== only) {
    if (fromSoftPin) only = null; else return 'unit-owner-other';
  }
  // 'prefer' … 並べ替えの **いちばん前** へ置くだけ('soft')。🚨 顔ぶれは1人も減らさない。
  const unitFirst = (hg.kind === 'prefer' && hg.first) ? hg.first : null;
  const prefersUnit = (name) => (unitFirst !== null && name === unitFirst ? 1 : 0);

  // 指示書5.5-7「共通作業は、担当できる技能の範囲が狭い人から」。
  // 同じ広さなら、候補一覧の並び(根拠の確かさ→件数→名前。historyEligibility が決めた順)を保つ。
  //
  // 👤 2026-09-06 追加: 個人設定で「この人はこのテンプレを優先」にした人を **いちばん前** に置く。
  //   🚨 できる人の顔ぶれ(freeNow)は1人も変えない。**順番だけ**。
  //     能力に混ぜると「優先にしていないから頼めない」になり、実績で出来ると分かっている人を外す。
  //   ⚠ 優先が1人も居なければ、並びはいままでと1ミリも変わらない(設定が空なら素通り)。
  const tplId = String(job.templateId ?? '');
  const prefersThis = (name) => {
    if (!tplId || state.workerTemplatePrefs.size === 0) return 0;
    const s = state.workerTemplatePrefs.get(name);
    return (s && s.has(tplId)) ? 1 : 0;
  };
  // 🧷 前回の担当が **いちばん前**(台を持っている人の次)。渡されていなければ全員 0 で素通り。
  const prevOf = state.prevWorkers && state.prevWorkers.size ? (state.prevWorkers.get(String(job.lotId ?? '')) || '') : '';
  const prefersPrev = (name) => (prevOf && name === prevOf ? 1 : 0);
  const ordered = freeNow
    .map((name, i) => ({ name, i }))
    // 👥 その台を持っている人が **いちばん前**('soft' の時だけ。切ってあれば全員 0 で素通り)
    .sort((a, b) => (prefersUnit(b.name) - prefersUnit(a.name))
      || (prefersPrev(b.name) - prefersPrev(a.name))
      || (prefersThis(b.name) - prefersThis(a.name))
      || ((state.breadth.get(a.name) ?? 0) - (state.breadth.get(b.name) ?? 0))
      || (a.i - b.i))
    .map((x) => x.name);
  // 🧵 この人にだけ渡す時は「誰に」をその人だけに絞る。⚠ 相方(OJT・2人でやる工程)は ordered(全員)から探す。
  // 🧪 parallelLab: 終了対応(#finish)は自動を始めた同じ人だけ
  const pickFrom0 = only == null ? ordered : ordered.filter((n) => n === only);
  const pickFrom = job.requiredWorker ? pickFrom0.filter((n) => n === job.requiredWorker) : pickFrom0;
  if (only != null && pickFrom.length === 0) return 'no-free';

  // 🧷👤 2026-09-17 前回の担当／「優先」の人が いま手が空いていなくても、**納期に余裕がある間** はその人を待つ
  //   (他の人に渡さない)。渡されなければ1行も動かない: prevWorkers が在るか templatePrefMode==='reserve' の時だけ。
  //   余裕 = いま + 所要×2 ≦ 納期線(無ければ待たない)。その人にこの期間 働ける時間が無ければ待たない(永遠に待たせない)。
  if (only == null) {
    const holders = [];
    if (prevOf && names.includes(prevOf) && state.rosterSet.has(prevOf)) holders.push(prevOf);
    if (state.templatePrefMode === 'reserve' && tplId && state.workerTemplatePrefs.size) {
      for (const [n, s] of state.workerTemplatePrefs) {
        if (s.has(tplId) && names.includes(n) && state.rosterSet.has(n) && !holders.includes(n)) holders.push(n);
      }
    }
    if (holders.length && !holders.some((n) => pickFrom.includes(n))) {
      const due = finite(job.dueLineMs); const dur = finite(job.durationMs);
      const slackOk = (due != null && dur != null) ? (state.now + dur * 2 <= due) : false;
      // その人が今の仕事を終える時刻(endMsByJob)。それが分からない(手が空いているのに候補に居ない=休み等)なら待たない。
      //   待つのは「終えた後にこの仕事を納期まで・期間の中で終えられる」時だけ(永遠に待って未定にしない)。
      const freeAt = holders.map((n) => { const jid = state.holderOf.get(n); return jid != null ? finite(state.endMsByJob.get(jid)) : null; }).filter((e) => e != null).sort((x, y) => x - y)[0] ?? null;
      //   🚨 待つのは その人が **1仕事ぶん以内** に空く時だけ(freeAt − いま ≦ 所要)。長く待つと期間の中で手が付かず「未定」になる(写しで実測)。
      //   待ち始めてから 所要×2 を越えたら諦める(その人が別のロットを続けて空かない時に、期間の中で手が付かず「未定」になるのを防ぐ)。
      if (!state.holdSince) state.holdSince = new Map();
      const since = state.holdSince.has(job.jobId) ? state.holdSince.get(job.jobId) : state.now;
      const alive = freeAt != null && dur != null && (state.now - since <= dur * 2) && (freeAt + dur <= state.horizonEnd) && (due == null || freeAt + dur <= due) && holders.some((n) => workMsInWindow(state, n) > 0);
      if (alive && !state.holdSince.has(job.jobId)) state.holdSince.set(job.jobId, state.now);
      if (slackOk && alive) {
        state.heldJobIds.add(job.jobId);
        if (!state.holdSeen) state.holdSeen = new Set();
        if (!state.holdSeen.has(job.jobId)) {
          state.holdSeen.add(job.jobId);
          decisions.push({
            atMs: state.now, kind: 'wait-preferred', jobId: job.jobId, lotId: job.lotId, worker: holders[0],
            reason: `${holders[0]}さんの手が空くのを待っています（${holders[0] === prevOf ? '前回の担当' : '優先のテンプレ'}・納期に余裕がある間だけ）`,
          });
        }
        return 'reserved';
      }
    }
  }

  const reserved = [];
  let picked = null;
  for (const name of pickFrom) {
    // 指示書5.6「熟練者しかできない作業が待っている時、熟練者を一般作業へ割り当てない」
    // 🚨 ここは人ごとの ctx を渡していたので、工程ごとの索引が **人数ぶん** 作り直されていた。
    //   reserveSpecialist は担当者を引数(name)で受け取るので、ctx を人で分ける必要が無い。
    //   本番の工程キーは約290種あり、人ごとに作り直すと1ラウンドで4回なめる事になる。
    // ⚙ 設定 reserveSpecialist=false(opsimRules): 温存しない
    if (!allowReserved && (state.scenario && state.scenario.reserveSpecialist) !== false && reserveSpecialist(job, name, roundCtx(state, undefined))) {
      reserved.push(name);
      continue;
    }
    picked = name;
    break;
  }
  if (picked == null) return 'reserved';

  // ── OJT の仮配置(S22) ────────────────────────────────────────────────────
  // 指導者と受講者の2人分を同時に使う。受講者の手が空いていない時は、
  // 仕事を止めずに指導者が単独で進める(止めると、教育の仮定が納期を悪化させてしまう)。
  const ojt = state.ojtByProcess.get(String(job.processKey ?? '')) || null;
  let partner = null;
  if (ojt) {
    if (picked !== ojt.mentor && pickFrom.includes(ojt.mentor) && !reserved.includes(ojt.mentor)) {
      picked = ojt.mentor;
    }
    if (picked === ojt.mentor && ojt.trainee !== picked && isWorkerFree(state, ojt.trainee)) {
      partner = ojt.trainee;
    }
  }

  // ── 2人でできる工程（🚨 既定は空＝1件も無い）────────────────────────────
  // 🚨 ここで **時間は1ミリも縮めない**。
  //   下の endMs は addWorkMs(startMs, durationMs, picked) で、2人でも所要時間は同じ。
  //   「2人だと何倍早いか」は **測っていない** ので、勝手に縮めると測っていない数字を作る事になる。
  //   いまの意味は「その工程は2人を同時に押さえる」だけ。相方が居なければ着手しない。
  if (partner == null && state.twoPersonProcessKeys.has(String(job.processKey ?? ''))) {
    const mate = ordered.find((n) => n !== picked && !reserved.includes(n) && isWorkerFree(state, n));
    if (mate) {
      partner = mate;
    } else {
      // ⚠ 既存の OJT は相方が空いていなければ黙って1人で走る。ここは同じにしない
      //   （「2人でやる工程」と言われた物を1人で走らせたら、その指定が効いていない）。
      if (!state.needPartnerSeen) state.needPartnerSeen = new Set();
      if (!state.needPartnerSeen.has(job.jobId)) {
        state.needPartnerSeen.add(job.jobId);
        decisions.push({
          atMs: state.now, kind: 'wait-need-partner', jobId: job.jobId, lotId: job.lotId,
          reason: '2人でできる工程に指定されていますが、もう1人の手が空いていません',
        });
      }
      return 'need-partner';
    }
  }

  // 🏭 相方が決まった後に、区画の定員をもう一度だけ見る(2人で入ると溢れる場合)。
  //   ⚠ ここまで holderOf も zoneUsed も 1つも書いていないので、返しても占有は漏れない。
  //   相方が「教える為(OJT)」なら、既存の流儀に合わせて **相方を外して1人で進める**。
  //   「2人でやる工程」の指定なら、1人では走らせない(指定が効かなくなる為)ので場所待ちにする。
  const zoneHeads0 = 1 + (partner ? 1 : 0);
  if (zoneCap != null && (state.zoneUsed.get(zid) || 0) + zoneHeads0 > zoneCap) {
    const isTwoPerson = state.twoPersonProcessKeys.has(String(job.processKey ?? ''));
    if (partner && !isTwoPerson) {
      partner = null;   // OJT の相方だけ外す(仕事は止めない)
    } else {
      if (!state.zoneWaitSeen.has(job.jobId)) {
        state.zoneWaitSeen.add(job.jobId);
        decisions.push({
          atMs: state.now, kind: 'wait-zone', jobId: job.jobId, lotId: job.lotId, zoneId: zid,
          reason: `${IDLE_REASON.ZONE_FULL}（${state.zoneName.get(zid) || zid} は同時 ${zoneCap}人まで・この工程は2人必要）`,
        });
      }
      return 'zone-full';
    }
  }

  // ── 開始と終わり ────────────────────────────────────────────────────────
  // A plan lock is stronger than OJT's optional mentor/partner changes.
  // Reject, never manufacture a worker or bypass skill/calendar/equipment gates.
  if (planLock && (picked !== planLock.worker || partner !== planLock.partner)) return 'pinned-other';
  // 🧪 parallelLab: 前の仕事と場所が違えば 登録した片道の分を足す(登録が無ければ足さず、数える)
  const trav = state.parallelLab ? parallelLabTravel(state, job, picked) : null;
  if (trav && !trav.known && !job.parallelLabFinish && state.parallelLab.unknownTravel === 'exclude') { state.parallelLabExcluded.add(job.jobId); return 'travel-unknown'; }
  // 🚨 第三者(2026-09-23)③: 戻る余裕(returnMarginMin)が登録されていれば、離れている人は
  //   「行き＋その仕事＋帰りが 自動の終わり−余裕 に収まる仕事」だけ取る(＝間に合う範囲で応援)。未登録なら 全体の納期で採点(待たせてよい)
  if (state.parallelLab && !job.parallelLabFinish && state.awayOf.has(picked) && Number.isFinite(Number(state.parallelLab.returnMarginMin))) {
    const away = state.awayOf.get(picked);
    const dur = finite(job.durationMs) || 0;
    const back = parallelLabBack(state, job, away).ms;
    if (state.now + (trav ? trav.ms : 0) + dur + back > away.autoEndMs - Number(state.parallelLab.returnMarginMin) * 60000) {
      state.parallelLabReturnGated.add(job.jobId); return 'return-margin';
    }
  }
  const startMs = state.now + (trav ? trav.ms : 0);   // isWorkerFree が「今その人が働ける」を確かめている
  const baseDurationMs = finite(job.durationMs);
  if (baseDurationMs == null || job.durationKnown === false) return 'duration-unknown';

  // 🚨🚨 工数を膨らませるのは **この1本だけ**(inflateDurationMs)。
  //   あちこちで掛けると二重になる。切ってある間(既定)は baseDurationMs をそのまま返す。
  const inflated = inflateDurationMs(state, job, picked, baseDurationMs);
  const durationMs = inflated.ms;

  let endMs;
  try {
    // ⚠ 終わる時刻は calendar に数えさせる。休憩・終業・土日・休みをまたぐ足し算を
    //   ここで書くと、画面と結果で違う時刻が出る。
    //   OJT の時は指導者の時計で数える(2人の勤務が違う場合、受講者はその間ずっと拘束)。
    endMs = state.calendar.addWorkMs(startMs, durationMs, picked);
  } catch {
    return 'no-time';
  }

  // ── ⏸ 中断(電話・呼び出し・部品待ち) ───────────────────────────────────
  // 🚨 工数(人が手を動かす秒数)には足さない。**終わる時刻だけ** を後ろへずらす。
  //   ずらすのは実時間で、稼働カレンダーには通さない(待ちは夜も土日も進む)。
  // 🚨 切ってある間(既定)は applyInterruption が渡した時刻をそのまま返す。
  let interruptionAddedMs = 0;
  if (state.interruptionMode !== INTERRUPTION_MODE.OFF) {
    const it = applyInterruption(endMs, {
      key: { model: job.model, templateId: job.templateId, stepId: job.stepId },
      rates: state.interruptionRates,
      mode: state.interruptionMode,
      useAll: state.interruptionUseAll,
    });
    if (it.applied && it.ms != null) { endMs = it.ms; interruptionAddedMs = it.addedMs; }
  }

  const reason = planLock ? '保存計画の担当を維持しています' : assignReason(names.length, partner);
  const rec = {
    jobId: job.jobId,
    lotId: job.lotId,
    worker: picked,
    // 🚨 相方は **結果に載せる**。載せないと「2人でできる工程」の指定が効いたのか
    //   画面からも試験からも確かめられない（＝効いていない機能に気付けない）。
    //   相方が居ない時は null。0人でも「居ない」でもなく null（測っていないのではなく、居ない）。
    partner: partner || null,
    startMs,
    endMs,
    evidence: evidence.get(picked) ?? EVIDENCE.UNKNOWN,
    reason,
    // 🧷👤 2026-09-17 誰を選んだ理由の印(前回の担当 / 優先のテンプレ)。無い時は鍵ごと出さない(結果の形を変えない)。
    ...(prevOf && picked === prevOf ? { pickedFor: 'prev' }
      : ((tplId && state.workerTemplatePrefs.size && (state.workerTemplatePrefs.get(picked) || new Set()).has(tplId)) ? { pickedFor: 'tpl-pref' } : {})),
    // 🆕 膨らませた時だけ、何をどれだけ足したかを **結果に載せる**。
    //   ⚠ 載せないと「入れたのに効いていない」に誰も気付けない。
    //   🚨 切ってある間(既定)は鍵ごと出さない = 結果の形も1バイト変わらない。
    ...(inflated.ms !== baseDurationMs || interruptionAddedMs !== 0
      ? {
        baseDurationMs,
        durationMs,
        reworkExtraSec: inflated.reworkExtraSec,
        speedRatio: inflated.speedRatio,
        setupExtraSec: inflated.setupSec,
        interruptionAddedMs,
      }
      : {}),
  };
  state.assignments.push(rec);

  // 👥 持ち主を書き替え、**替わったなら理由を残す**。
  //   ⚠ state.running へ入れる前に呼ぶ(前の持ち主が「今している仕事」を引く為)。
  //   ⚠ names(この工程を任せられる人)も渡す。前の持ち主がそこに **入っていない** なら
  //     理由は「別の仕事」ではなく「この工程の記録が無い」。
  noteHandoff(state, job, picked, startMs, names);

  // 🏭 区画を何人ぶん使うか。⚠上限を決めていない区画(zoneCap==null)は数えない
  //   (数えると、上限を入れた瞬間に「もう満杯」から始まってしまう)。
  const zoneHeads = (zoneCap != null) ? (1 + (partner ? 1 : 0)) : 0;
  // 🔧 設備は **台**。2人で1台を触っても埋まるのは1台なので、必要台数は常に1。
  //   ⚠ 上限を決めていない設備は数えない(区画と同じ。数えると上限を入れた瞬間に満杯から始まる)。
  const equipmentHeads = capEq != null ? 1 : 0;
  const running = { job, rec, worker: picked, partner, startMs, endMs, equipmentId: exclusiveEq, jobId: job.jobId, zoneId: zoneHeads > 0 ? zid : null, zoneHeads, capEquipmentId: equipmentHeads > 0 ? capEq : null, equipmentHeads };
  state.running.set(job.jobId, running);
  state.recordByJob.set(job.jobId, running);
  state.endMsByJob.set(job.jobId, endMs);
  state.holderOf.set(picked, job.jobId);
  if (partner) state.holderOf.set(partner, job.jobId);
  if (state.parallelLab) {
    if (trav) { if (trav.known) state.parallelLabStats.travelAdded += 1; else if (trav.zoneUnknown) state.parallelLabStats.zoneUnknown += 1; else state.parallelLabStats.travelUnknown += 1; if (trav.zone) state.lastZoneOf.set(picked, trav.zone); }
    if (job.parallelLabFinish) { state.awayOf.delete(picked); state.movedWhileAway.delete(picked); state.awayReturnAtOf.delete(picked); }   // 帰着
    else if (state.awayOf.has(picked)) {
      state.movedWhileAway.add(picked);
      const back = parallelLabBack(state, job, state.awayOf.get(picked));
      state.awayReturnAtOf.set(picked, { atMs: endMs + back.ms, known: back.known, zoneUnknown: back.zoneUnknown });
    }
    parallelLabRelease(state, job, picked, running);
  }
  // 🧵 いま持っているロットを書き替える。別のロットへ移ったなら、なぜ離れたかを残す
  //   (🚨 理由を積むのは lotFocus が立っている時だけ。切ってある時は結果の形を1バイトも変えない)。
  for (const who of (partner ? [picked, partner] : [picked])) {
    const prevLot = state.currentLotOf.get(who);
    if (state.lotFocus && prevLot != null && prevLot !== job.lotId) noteLotSwitch(state, who, prevLot, job, startMs);
    state.currentLotOf.set(who, job.lotId);
    state.lastStartOf.set(who, startMs);
  }
  if (exclusiveEq != null) state.busyEquipment.set(exclusiveEq, job.jobId);
  if (zoneHeads > 0) state.zoneUsed.set(zid, (state.zoneUsed.get(zid) || 0) + zoneHeads);
  if (equipmentHeads > 0) state.equipmentUsed.set(capEq, (state.equipmentUsed.get(capEq) || 0) + equipmentHeads);
  // 🔀 段取り替えの「前の型式」。⚠ 切ってある間(既定)は1つも書かない。
  if (state.setupMode !== SETUP_MODE.OFF) {
    state.lastModelByWorker.set(picked, job.model == null ? '' : String(job.model));
    if (partner) state.lastModelByWorker.set(partner, job.model == null ? '' : String(job.model));
  }

  // 手が付いた仕事を、残っている仕事の一覧から外す。
  // ⚠ priority.reserveSpecialist はこの配列を **呼ばれる度に** 読む。
  //   外し忘れると、もう配った仕事を「まだ待っている専門作業」と数えてしまう。
  // 🚨 2026-09-04（案A の①）: 1件外すのに **配列を作り直さない**。
  //   filter は毎回「残り全部」を新しい配列へ写す（1か月ぶんだと仕事1,000件×配った回数だけ写す）。
  //   splice は同じ配列から1つ抜くだけ。**並びは1つも変わらない**ので答えは同じ。
  {
    const at = state.pendingJobs.findIndex((j) => j.jobId === job.jobId);
    if (at >= 0) state.pendingJobs.splice(at, 1);
  }

  closeIdle(state, picked, startMs);
  if (partner) closeIdle(state, partner, startMs);

  decisions.push({
    atMs: startMs,
    kind: 'assign',
    jobId: job.jobId,
    lotId: job.lotId,
    worker: picked,
    partner,
    evidence: rec.evidence,
    reason,
    slackMs: slackMs(job, startMs, state.calendar, picked),
    endMs,
    candidates: auditCandidates(state, job, names, evidence, picked, partner, reserved),
  });
  return 'assigned';
}

/**
 * 👥 その人がいま手を動かしている仕事(替わった理由の1行に入れる為だけ)。
 * 🚨 何もしていなければ null。null を渡された splitWhy は文を作らない側へ倒す。
 */
function runningRecOf(state, name) {
  for (const rec of state.running.values()) {
    if (rec.worker === name || rec.partner === name) return rec;
  }
  return null;
}

/**
 * 👥 台の持ち主を書き替え、人が替わったら **なぜ替わったか** を残す。
 *
 * 清水さん(2026-09-10)「分担って書いてあるけど、なんで分担したって書いてないからわかりづらい」
 * 🚨 区切りの設定に関わらず **どの設定でも残す**。'none'(いままでどおり)の答えでも、
 *   なぜ分かれたのかが画面に出ていない事が清水さんの困り事だった。
 *   ⚠ 残すのは lotResults の説明用の鍵だけで、割付・終わる時刻・遅れ・指紋は1バイトも動かさない。
 * 🚨 台の途中の替わり(midUnit:true)と 台の境の替わり(midUnit:false)を分けて持つ。
 *   前者が「区切りの悪い分担」、後者が清水さんの言う「区切りの良いところで分担」。
 * 🚨 分からない事は書かない。前の人が何をしていたかも読めず、いないのでもない時は
 *   **文を作らない(why を空にする)**。もっともらしい札を貼ると画面に嘘が出る。
 */
function noteHandoff(state, job, picked, atMs, eligibleNames = null) {
  const lotId = job.lotId;
  const unitKey = unitKeyOf(job);
  const uIdx = (job.unitIndex === null || job.unitIndex === undefined) ? null : Number(job.unitIndex);
  const prevUnit = unitKey == null ? '' : (state.unitOwner.get(unitKey) || '');
  const last = state.lotOwner.get(lotId) || null;

  let from = '';
  let midUnit = false;
  if (prevUnit && prevUnit !== picked) {
    from = prevUnit;              // 台の途中で替わった(いままで20.7%で起きていた物)
    midUnit = true;
  } else if (!prevUnit && last && last.owner && last.owner !== picked) {
    from = last.owner;            // 台の境で替わった(区切りの良い分担)
    midUnit = false;
  }

  if (from) {
    const busyRec = runningRecOf(state, from);
    let busyWith = null;
    if (busyRec) {
      const titles = state.stepTitleByLot.get(busyRec.job.lotId);
      busyWith = {
        model: busyRec.job.model == null ? '' : String(busyRec.job.model),
        stepTitle: titles ? String(titles.get(busyRec.job.stepIndex) ?? '') : '',
      };
    }
    let away = false;
    if (busyRec == null) {
      try { away = !state.calendar.isAvailable(atMs, from); } catch { away = false; }
    }
    // 🚨 2026-09-10 の確かめ役の指摘で言い方を4つへ。前は busy と away の2通りしか無く、
    //   「その工程の記録が無い人」と「順番で先を越された人」は **理由が空のまま** 残っていた。
    //   清水さんが見たいのは まさにその「なんで分担したか」なので、必ず1行言う。
    const titles = state.stepTitleByLot.get(lotId);
    const thisStepTitle = titles ? String(titles.get(job.stepIndex) ?? '') : '';
    const canDoThisStep = Array.isArray(eligibleNames) ? eligibleNames.includes(from) : null;
    let kind = SPLIT_KIND.BUSY;
    if (busyRec != null) kind = SPLIT_KIND.BUSY;
    else if (away) kind = SPLIT_KIND.AWAY;
    else if (canDoThisStep === false) kind = SPLIT_KIND.NO_SKILL;
    else if (canDoThisStep === true) kind = SPLIT_KIND.OUTRUN;
    else kind = null;   // 候補が読めない時だけ、言えない事を言わない(空のまま残す)
    const why = kind
      ? splitWhy({ from, to: picked, unitIndex: uIdx, kind, busyWith, away, stepTitle: thisStepTitle })
      : '';
    let list = state.unitSplits.get(lotId);
    if (!list) { list = []; state.unitSplits.set(lotId, list); }
    list.push({ unitIndex: uIdx, from, to: picked, atMs, why, midUnit, ...(kind ? { kind } : {}) });
  }

  if (unitKey != null) state.unitOwner.set(unitKey, picked);
  // 「いちばん先まで進んだ台」とその持ち主。
  // ⚠ ロットに1回だけの工程(台に属さない)は台を進めない。持ち主だけ書き替える。
  if (last == null) state.lotOwner.set(lotId, { unitIndex: uIdx, owner: picked });
  else if (uIdx == null) state.lotOwner.set(lotId, { unitIndex: last.unitIndex, owner: picked });
  else if (last.unitIndex == null || uIdx >= last.unitIndex) {
    state.lotOwner.set(lotId, { unitIndex: uIdx, owner: picked });
  }
}

/**
 * 🚨🚨 工数(その仕事1件に人が手を動かす時間)を膨らませる **唯一の場所**。
 *
 * ここ以外で 修正率・人の速さ・段取り替え を掛けてはいけない。
 * あちこちで掛けると同じ物を2回数える(2026-09-10 の申し送り)。
 *
 * 順番と、その順番にした理由:
 *   ① 修正(applyReworkRate)  … 「その工程で発生する やり直しの時間」。仕事そのものが増える。
 *      🚨 土台に修正が入っているかを **呼ぶ側が言い切った時だけ** 上乗せする。
 *        実績から出た見積り(model-step / step-group)は estimate.js が duration+reworks を
 *        数えているので **もう入っている** → 上乗せしない(reworkBaseIncludes が true)。
 *   ② 人の速さ(applyWorkerSpeed) … ①で決まった「やる仕事の量」に、その人の倍率を掛ける。
 *      ⚠ 倍率は「その人の中央値 ÷ 全体の中央値」の無次元の数なので、①の後に掛けてよい。
 *   ③ 段取り替え(setupExtraSec) … 前と違う型式を始める時の切り替えの時間を **足す**。
 *      🚨 ②の後に足す。切り替えの実測は色々な人が混ざった記録なので、
 *        ここへ人の倍率を掛けると、測っていない数字を作る事になる。
 *
 * 🚨 3つとも切ってある(既定)なら baseMs をそのまま返す = いままでと1ミリも同じ。
 * @returns {{ ms:number, reworkExtraSec:number, speedRatio:number|null, setupSec:number }}
 */
function inflateDurationMs(state, job, worker, baseMs) {
  const off = state.reworkMode === REWORK_MODE.OFF
    && state.workerSpeedMode === SPEED_MODE.OFF
    && state.setupMode === SETUP_MODE.OFF;
  if (off) return { ms: baseMs, reworkExtraSec: 0, speedRatio: null, setupSec: 0 };

  const stepKey = String(job.processKey ?? '');
  const key = { model: job.model, templateId: job.templateId, stepId: job.stepId };
  let sec = baseMs / 1000;
  let reworkExtraSec = 0;
  let speedRatio = null;
  let setupSec = 0;

  // ① 修正
  if (state.reworkMode !== REWORK_MODE.OFF) {
    const r = applyReworkRate(sec, {
      key,
      rates: state.reworkRates,
      mode: state.reworkMode,
      useAll: state.reworkUseAll,
      // 🚨 分からない鍵は **渡さない**(undefined)。applyReworkRate は言われない限り上乗せしない。
      baseIncludesRework: state.reworkBaseIncludes.get(lotStepKeyOf(job.lotId, job.stepId)),
    });
    if (r.applied && r.sec != null) { sec = r.sec; reworkExtraSec = r.extraSec; }
    // 📊 効いた件数と理由の内訳(code は applyReworkRate の言い方をそのまま数える。ここで言い換えない)。
    if (state.inflation) {
      const c = state.inflation.rework;
      if (r.applied) c.applied += 1;
      const k = String(r.code || (r.applied ? 'applied' : 'unknown'));
      c.byCode[k] = (c.byCode[k] || 0) + 1;
    }
  }

  // ② 人ごとの速さ
  if (state.workerSpeedMode !== SPEED_MODE.OFF) {
    const w = applyWorkerSpeed(sec, {
      worker, stepKey, speed: state.workerSpeed, mode: state.workerSpeedMode,
    });
    if (w.applied && w.sec != null) { sec = w.sec; speedRatio = w.ratio; }
    if (state.inflation) {
      const c = state.inflation.workerSpeed;
      if (w.applied) c.applied += 1;
      const k = String(w.source || (w.applied ? 'applied' : 'none'));
      c.bySource[k] = (c.bySource[k] || 0) + 1;
    }
  }

  // ③ 段取り替え
  if (state.setupMode !== SETUP_MODE.OFF) {
    const e = setupExtraSec({
      prevModel: state.lastModelByWorker.get(worker) || '',
      nextModel: job.model == null ? '' : String(job.model),
      stepKey,
      setup: state.setupChange,
      mode: state.setupMode,
      baseKind: state.setupBaseKind,
    });
    if (e.applied && e.sec > 0) { sec += e.sec; setupSec = e.sec; }
    if (state.inflation) {
      const c = state.inflation.setupChange;
      if (e.applied && e.sec > 0) c.applied += 1;
      const k = String(e.source || (e.applied ? 'applied' : 'none'));
      c.bySource[k] = (c.bySource[k] || 0) + 1;
    }
  }

  // ⚠ 1ミリ秒未満にしない。0 にすると「時間のかからない仕事」と読めてしまう。
  return { ms: Math.max(1, Math.round(sec * 1000)), reworkExtraSec, speedRatio, setupSec };
}

function assignReason(candidateCount, partner) {
  if (partner) return 'OJT（指導する人と受ける人の2人で実施）';
  if (candidateCount === 1) return 'この工程を頼める記録がこの人だけ';
  return '納期余裕の小さい仕事から、技能の範囲が狭い人へ';
}

/** 画面の「なぜこの人が選ばれたか」(指示書6.5)。多すぎると重いので頭を切る。 */
function auditCandidates(state, job, names, evidence, picked, partner, reserved) {
  const out = [];
  for (const name of names) {
    if (out.length >= MAX_AUDIT_CANDIDATES) break;
    let note;
    if (name === picked) note = '選びました';
    else if (name === partner) note = 'OJTで一緒に入りました';
    else if (reserved.includes(name)) note = IDLE_REASON.RESERVED;
    else if (state.holderOf.has(name)) note = '別の作業に入っています';
    else if (!state.calendar.isAvailable(state.now, name)) {
      note = unavailableIdleReason(state.calendar.unavailableReason(state.now, name));
    } else note = '順番が後になりました';
    out.push({ name, evidence: evidence.get(name) ?? EVIDENCE.UNKNOWN, note });
  }
  return out;
}

// ----------------------------------------------------------------------------
// 5. 待機の記録(理由つき)
// ----------------------------------------------------------------------------
function recordIdle(state, runnable) {
  // 配り終わった後に残っている仕事。これが「適格な仕事が残っているか」の判断材料。
  const left = runnable.filter((j) => !state.endMsByJob.has(j.jobId) && !state.doneJobIds.has(j.jobId));
  for (const name of state.workerNames) {
    if (state.holderOf.has(name)) { closeIdle(state, name, state.now); continue; }
    const reason = idleReasonFor(state, name, left);
    const open = state.idleOpen.get(name);
    if (open && open.reason === reason) continue;   // 同じ理由が続いている間は1本にまとめる
    closeIdle(state, name, state.now);
    state.idleOpen.set(name, { fromMs: state.now, reason });
  }
}

function closeIdle(state, name, toMs) {
  const open = state.idleOpen.get(name);
  if (!open) return;
  state.idleOpen.delete(name);
  // 長さ0の待機は残さない(終わった瞬間に次へ移った時に出る)
  if (toMs > open.fromMs) {
    state.idleLog.push({ worker: name, fromMs: open.fromMs, toMs, reason: open.reason });
  }
}

function idleReasonFor(state, name, left) {
  // ① そもそも働けない
  const un = state.calendar.unavailableReason(state.now, name);
  const unReason = unavailableIdleReason(un);   // 休み・他の作業・応援・土日・始業前・休憩・終業後
  if (unReason) return unReason;

  // ② 今すぐ始められる仕事が1件も無い
  if (left.length === 0) {
    if (state.pendingJobs.length === 0) return IDLE_REASON.NO_JOB;
    const waitingArrival = state.pendingJobs.some((j) => {
      const a = finite(j.arrivalMs);
      return a != null && a > state.now;
    });
    if (waitingArrival) return IDLE_REASON.ARRIVAL;
    // 🚨 ここも「それ以外は全部前工程待ち」の受け皿だった。確かめてから言う。
    const allNoTime = state.pendingJobs.every((j) => j.durationKnown === false || !(finite(j.durationMs) > 0));
    if (allNoTime) return IDLE_REASON.NO_TARGET_TIME;
    const anyBlocked = state.pendingJobs.some((j) => j.afterJobId && !state.doneJobIds.has(j.afterJobId));
    if (anyBlocked) return IDLE_REASON.PREV_STEP;
    return IDLE_REASON.UNEXPLAINED;
  }

  // ③ この人に頼める仕事があるか
  const mine = left.filter((j) => eligibleOf(state, j.processKey).names.includes(name));
  if (mine.length === 0) return IDLE_REASON.NO_SKILL_MATCH;
  if (mine.every(j => { const p = lockOf(j, state.planJobLocks); return p && p.worker !== name && p.partner !== name; })) return IDLE_REASON.PLAN_FIXED;

  // ④ 設備がふさがっているだけか
  const allEquipmentBusy = mine.every((j) => {
    const eq = (j.equipmentId === '' || j.equipmentId === undefined) ? null : j.equipmentId;
    // ⚠ 上限を決めた設備は ④″(台数の門)が言う。ここは 上限の無い設備(1件ずつの門)だけ。
    return eq != null && !state.equipmentCap.has(String(eq)) && state.busyEquipment.has(eq);
  });
  if (allEquipmentBusy) return IDLE_REASON.EQUIPMENT;

  // ④″ 🔧 頼める仕事が全部「設備の台数が埋まっている」か。
  //   ⚠ 塞ぐ側(tryAssign の equipmentGate)と必ずセット。ここを書き忘れると
  //     画面に UNEXPLAINED『理由をまだ言えません』が出る。
  if (state.equipmentOfStep.size > 0 || state.equipmentCap.size > 0) {
    const allEquipmentFull = mine.every((j) => {
      // 🔧 塞ぐ側(tryAssign の capEq)と同じ引き方: 仕事に付いた id が先、無ければ工程キーの索引。
      const own = (j.equipmentId === '' || j.equipmentId === undefined || j.equipmentId === null) ? null : String(j.equipmentId);
      const id = (own != null && state.equipmentCap.has(own))
        ? own : (state.equipmentOfStep.get(String(j.processKey ?? '')) ?? null);
      if (id == null) return false;
      const cap = state.equipmentCap.get(id);
      return cap != null && (state.equipmentUsed.get(id) || 0) >= cap;
    });
    if (allEquipmentFull) return IDLE_REASON.EQUIPMENT_FULL;
  }

  // ④′ 🏭 頼める仕事が全部「場所が満杯」か。
  //   ⚠ 塞ぐ側(tryAssign)と必ずセット。ここを書き忘れると
  //     画面に UNEXPLAINED『理由をまだ言えません』が出る(既存の見張りは1本も赤にならない)。
  if (state.zoneCapacity.size > 0) {
    const allZoneFull = mine.every((j) => {
      const z = (j.zoneId === '' || j.zoneId === undefined || j.zoneId === 'zone_unassigned') ? null : j.zoneId;
      if (z == null) return false;
      const cap = state.zoneCapacity.get(z);
      return cap != null && (state.zoneUsed.get(z) || 0) >= cap;
    });
    if (allZoneFull) return IDLE_REASON.ZONE_FULL;
  }

  // ④‴ 👥 頼める仕事が全部「その台を続ける人が塞がっている」か。
  //   ⚠ 塞ぐ側(tryAssign の handoffGate)と必ずセット。ここを書き忘れると
  //     画面に UNEXPLAINED『理由をまだ言えません』が出る(ZONE_FULL の時と同じ穴)。
  //   🚨 区切りを 'unit' にした時だけ。切ってあれば1件も見ない(いままでと同じ答え)。
  if (state.handoff === HANDOFF_MODE.UNIT) {
    const allUnitOwned = mine.every((j) => {
      const k = unitKeyOf(j);
      if (k == null) return false;                 // ロットに1回の工程は門を掛けていない
      const owner = state.unitOwner.get(k) || '';
      if (!owner || owner === name) return false;  // まだ誰も持っていない / 自分が持っている
      // 持ち主がこの工程の候補に居ない台は門を掛けていない(tryAssign と同じ見方)
      const names2 = eligibleOf(state, j.processKey).names;
      return names2.includes(owner) && state.rosterSet.has(owner);
    });
    if (allUnitOwned) return IDLE_REASON.HANDOFF;
  }

  // ⑤ 「その人しか頼めない仕事のために手を空けた」か。
  //    🚨 2026-08-22: ここは以前「それ以外は全部これ」という受け皿だった。
  //    温存が働いていない時まで「専門の作業のために手を空けています」と画面に出る＝嘘。
  //    実測: 本番で尾田さんの16分の空きにこの札が付いていたが、待っていた相手は
  //    目標時間が無くて配れない仕事だった。→ 実際に聞いてから答える。
  // 🧷👤 ④' 残っている仕事が全部「前回の担当か優先の人を待つ物」なら、その理由(2026-09-17)
  if (mine.length && state.heldJobIds && state.heldJobIds.size && mine.every((j) => state.heldJobIds.has(j.jobId))) return IDLE_REASON.HELD;
  const ctx5 = roundCtx(state, undefined);
  if ((state.scenario && state.scenario.reserveSpecialist) !== false && mine.some((j) => reserveSpecialist(j, name, ctx5))) return IDLE_REASON.RESERVED;

  // ⑥ ①〜⑤のどれにも当てはまらない。
  //    🚨 もっともらしい札を貼らない。**分からないと書く**。
  //    この札が画面に出たら、それは私たちがまだ説明できていないという事で、直すべき合図。
  return IDLE_REASON.UNEXPLAINED;
}

// ----------------------------------------------------------------------------
// 6. 次の出来事へ時計を飛ばす
// ----------------------------------------------------------------------------
function nextEventAt(state) {
  const now = state.now;
  let best = state.horizonEnd;
  const consider = (t) => {
    const v = finite(t);
    if (v != null && v > now && v < best) best = v;
  };

  for (const rec of state.running.values()) consider(rec.endMs);   // 作業の完了
  consider(state.nextSnapshotAt);                                   // 画面の目盛り

  const hasPending = state.pendingJobs.length > 0;
  if (hasPending) {
    for (const j of state.pendingJobs) consider(j.arrivalMs);       // ロットの到着
    // 働ける/働けないの切り替わり(始業・休憩明け・終業・休みの明け)。
    // ⚠ 手が空いている人だけ見る。作業中の人の次の出来事は「完了」なので上で拾っている。
    for (const name of state.workerNames) {
      if (state.holderOf.has(name)) continue;
      consider(state.calendar.nextBoundaryAfter(now, name));
    }
  }
  return best;
}

function advanceWorkAndClock(state, nextAt) {
  // 作業の進み具合は「開始時刻 + calendar で数えた働ける時間」で決まっているので、
  // ここでやる事は時計を進める事だけ。
  // 🚨 必ず前へ進める。同じ時刻へ戻すと永久に回り続ける。
  state.now = nextAt > state.now ? nextAt : state.horizonEnd;
}

// ----------------------------------------------------------------------------
// 7. 画面用の記録(スナップショット)
// ----------------------------------------------------------------------------
function recordSnapshotIfNeeded(state) {
  const targets = state.snapshotTargets;
  if (!Array.isArray(targets) || targets.length === 0) return;
  // 時計は出来事まで飛ぶので、目標時刻を飛び越す事がある。飛ばした目標も1枚ずつ残す。
  while (state.nextTargetIndex < targets.length
    && targets[state.nextTargetIndex].targetMs <= state.now) {
    const t = targets[state.nextTargetIndex];
    // 🚨 上限は「暴走の安全弁」であって、普通は当たらない（5日18枚 / 30日31枚）。
    //   当たった時は **黙って止めない**。監査に残し、下の snapshotCoverage で未完了と分かる。
    if (state.snapshots.length >= MAX_SNAPSHOTS) {
      state.audit.push({
        atMs: state.now,
        kind: 'snapshot-limit',
        reason: `画面用の記録が ${MAX_SNAPSHOTS} 枚に達しました。`
          + `要求 ${targets.length} 枚のうち ${state.snapshots.length} 枚しか残していません`,
      });
      state.nextTargetIndex = targets.length;
      return;
    }
    const snap = buildSnapshot(state, t.targetMs);
    snap.elapsedDays = t.elapsedDays;
    state.snapshots.push(snap);
    state.nextTargetIndex += 1;
  }
}

/**
 * 大事な出来事を、粗い刻みとは別に残す（仕様の是正: 30日は1日刻みなので見落とす）。
 * 🚨 いまは「そのロットが初めて納期線を越えた瞬間」だけ。増やす時はここへ足す。
 */
function recordMilestones(state) {
  // 🚨 2026-09-04（案A の③）: なめるのは **見張りに残っているロットだけ**。
  //   1件も残っていなければ、この段は何もしない（1か月ぶんの繰り返しで一番効く）。
  //   ⚠ 並びは normalized.lots のまま。milestones の並びが変わると答えが変わる。
  const watch = state.milestoneWatch;
  if (!watch || watch.length === 0) return;
  for (let i = 0; i < watch.length; i += 1) {
    const lot = watch[i];
    const due = finite(lot.dueLineMs);
    if (due == null || due > state.now) continue;
    const jobs = state.jobsByLot.get(lot.lotId) || [];
    // 全部の仕事が終わっていれば越えていない。
    let done = true;
    // 「終わった」に入っている物だけで説明が付いたか。
    //   🚨 doneJobIds は **増える一方**（消す所が1つも無い）。全部入ったなら、この先も必ず done。
    //   逆に endMsByJob は release で消える事があるので、そちらでは見張りから外さない。
    let allFinished = true;
    for (const j of jobs) {
      if (state.doneJobIds.has(j.jobId)) continue;
      allFinished = false;
      const end = state.endMsByJob.get(j.jobId);
      if (end == null || end > due) { done = false; break; }
    }
    if (done) {
      if (allFinished) { watch.splice(i, 1); i -= 1; }
      continue;
    }
    state.seenBreachLots.add(lot.lotId);
    state.milestones.push({ kind: 'due-breach', lotId: lot.lotId, atMs: due });
    // 記録した物は、元の実装でも次から seenBreachLots で必ず捨てられていた。外して同じ。
    watch.splice(i, 1);
    i -= 1;
  }
}

/**
 * ある時刻の盤面。
 * 🚨 過去の時刻でも正しく出せるように、進行中の一覧ではなく **配置の記録** から組む
 *   (目盛りを飛び越した時に、後から1枚ずつ作れるようにするため)。
 */
function buildSnapshot(state, atMs) {
  const cal = state.calendar;
  const lots = [];

  for (const lot of state.normalized.lots) {
    const jobs = state.jobsByLot.get(lot.lotId) || [];
    let remainingMs = 0;
    let remainingKnown = true;
    let openCount = 0;
    const onIt = [];

    for (const job of jobs) {
      const rec = state.recordByJob.get(job.jobId);
      const dur = finite(job.durationMs);
      if (rec && rec.endMs <= atMs) continue;             // この時刻には終わっている
      openCount += 1;
      if (job.durationKnown === false || dur == null) { remainingKnown = false; continue; }
      if (rec && rec.startMs <= atMs) {
        // 作業中。進んだぶんは calendar が数えた「実際に働けた時間」。
        const done = cal.workMsBetween(rec.startMs, atMs, rec.worker);
        remainingMs += Math.max(0, dur - done);
        onIt.push(rec.worker);
        if (rec.partner) onIt.push(rec.partner);
      } else {
        remainingMs += dur;
      }
    }
    if (openCount === 0) continue;   // 片付いたロットは盤面から消す(指示書6.3)

    const totalMs = state.totalMsByLot.get(lot.lotId) ?? 0;
    lots.push({
      lotId: lot.lotId,
      model: lot.model,
      quantity: lot.quantity,
      templateId: lot.templateId,
      arrivalMs: lot.arrivalMs ?? null,
      dueLineMs: lot.dueLineMs ?? null,
      dueKind: lot.dueKind,
      remainingMs,
      remainingKnown,
      totalMs,
      // 進み具合のバー。分母はこのロットの目標時間の合計(PANEL_SPEC 3章)。
      doneRatio: totalMs > 0 ? clamp01(1 - (remainingMs / totalMs)) : null,
      // 🚨 カードの横位置。**到着から納期線までの時間の進み具合** ただ1つで決める(指示書6.3)。
      //   過去に2回「余裕 = 残り日数 − 要る日数」で出して、日を進めても値が動かなかった
      //   (残り日数と要る日数が同じだけ減って打ち消し合う)。
      //   下の式は分子だけが atMs で増える。atMs が進めば必ず大きくなる。
      duePosRatio: posRatioOf(lot, atMs),
      workers: onIt,
      late: lot.dueLineMs != null && atMs > lot.dueLineMs,
    });
  }

  const workers = state.workerNames.map((name) => {
    const rec = findRecordAt(state, name, atMs);
    if (rec) {
      const dur = finite(rec.job.durationMs) ?? 0;
      const done = cal.workMsBetween(rec.startMs, atMs, rec.worker);
      const titles = state.stepTitleByLot.get(rec.job.lotId);
      return {
        name,
        state: WORKER_STATE.WORKING,
        jobId: rec.job.jobId,
        lotId: rec.job.lotId,
        model: rec.job.model ?? null,
        unitIndex: rec.job.unitIndex,
        stepTitle: titles ? (titles.get(rec.job.stepIndex) ?? '') : '',
        endMs: rec.endMs,
        remainingMs: Math.max(0, dur - done),
        withWorker: rec.worker === name ? (rec.partner ?? null) : rec.worker,
        reason: null,
      };
    }
    const un = cal.unavailableReason(atMs, name);
    const away = un === 'off' || un === 'other-work' || un === 'roster-unknown' || un === 'support-product' || un === 'support-final';
    return {
      name,
      state: away ? WORKER_STATE.AWAY : WORKER_STATE.WAITING,
      jobId: null,
      lotId: null,
      model: null,
      unitIndex: null,
      stepTitle: '',
      endMs: null,
      remainingMs: null,
      withWorker: null,
      // その時刻の待機の理由。理由の無い待機を画面に出さない(指示書6.4)。
      reason: idleReasonAt(state, name, atMs, un),
    };
  });

  return { atMs, lots, workers };
}

const clamp01 = (v) => (v < 0 ? 0 : (v > 1 ? 1 : v));

/**
 * カードの横位置。到着から納期線までのどこまで来たか。
 * 🚨 上限で止めない。止めると越えた後にカードが動かなくなり、
 *   「越えてから何時間経ったか」が画面から消える。1 を超えたら越えた印。
 */
function posRatioOf(lot, atMs) {
  const from = finite(lot.arrivalMs);
  const to = finite(lot.dueLineMs);
  if (from == null || to == null) return null;   // 到着か納期が分からない物は位置を作らない
  const span = to - from;
  if (!(span > 0)) return null;
  return (atMs - from) / span;
}

function findRecordAt(state, name, atMs) {
  for (const rec of state.recordByJob.values()) {
    if (rec.startMs > atMs || rec.endMs <= atMs) continue;
    if (rec.worker === name || rec.partner === name) return rec;
  }
  return null;
}

/** その時刻に手が空いている理由。記録から後付けで出す(idleLog と同じ言い方を使う)。 */
function idleReasonAt(state, name, atMs, unavailable) {
  const unReason = unavailableIdleReason(unavailable);
  if (unReason) return unReason;
  for (const e of state.idleLog) {
    if (e.worker === name && e.fromMs <= atMs && atMs < e.toMs) return e.reason;
  }
  const open = state.idleOpen.get(name);
  if (open && open.fromMs <= atMs) return open.reason;
  return IDLE_REASON.NO_JOB;
}

// ----------------------------------------------------------------------------
// 8. 結果を組む
// ----------------------------------------------------------------------------
/**
 * ⚠ 指示書5.4 の骨格では最後の行が `return explainResult(state)` になっているが、
 *   CONTRACT.md の explainResult は
 *   `explainResult({ base, allSkills, scenarios, normalized })` という **別の関数**
 *   (原因と対策を出す物・explain.js)である。同じ名前にすると取り違えるので、
 *   ここは finalizeResult という名前にした。返す形は契約どおり。
 */
function finalizeResult(state) {
  for (const name of state.workerNames) closeIdle(state, name, state.now);

  const unresolved = classifyUnresolved(state);
  const lotResults = buildLotResults(state, unresolved.lotReasons);

  let breachAt = null;
  for (const r of lotResults) {
    if (!r.late || r.dueLineMs == null) continue;
    // 「最初に線を越えた実時刻」= 納期線そのもの。その瞬間、まだ終わっていなかった。
    if (breachAt == null || r.dueLineMs < breachAt) breachAt = r.dueLineMs;
  }

  // 🚨 「30日と言いながら12.5日で切れていた」を二度と黙って起こさない為の検査。
  //   画面は complete が false の時に「30日表示」と書いてはいけない。
  const targets = Array.isArray(state.snapshotTargets) ? state.snapshotTargets : [];
  const last = state.snapshots.length ? state.snapshots[state.snapshots.length - 1] : null;
  const snapshotCoverage = {
    requested: targets.length,
    captured: state.snapshots.length,
    complete: targets.length > 0 && state.snapshots.length === targets.length,
    lastElapsedDays: last && last.elapsedDays != null ? last.elapsedDays : null,
    /** 要求した終点。ここに届いていなければ「その日数ぶん見た」と言えない。 */
    requestedLastElapsedDays: targets.length ? targets[targets.length - 1].elapsedDays : null,
  };

  return {
    assignments: state.assignments,
    lotResults,
    // 🧪 ラボ専用の統計(scenario.parallelLab の時だけ鍵が出る)
    ...(state.parallelLab ? { parallelLabStats: { ...state.parallelLabStats, excluded: state.parallelLabExcluded.size, returnGated: state.parallelLabReturnGated.size } } : {}),
    idleLog: state.idleLog,
    snapshots: state.snapshots,
    /** 粗い刻みで見落とす出来事（納期を越えた瞬間など） */
    milestones: state.milestones,
    snapshotCoverage,
    breachAt,
    audit: state.audit,
    unresolved: unresolved.list,
    // 📊 修正率／人の速さ／段取り替えが実際に何件へ効いたか(理由の内訳つき)。
    //   🚨 3本とも切ってある間(既定)は鍵ごと出さない(答えの形を1バイトも変えない)。
    ...(state.inflation ? { realism: state.inflation } : {}),
  };
}

/**
 * 手が付かなかった仕事を、理由付きで出す。
 * 🚨 「時間が足りなくて順番が回らなかっただけ」の仕事はここへ入れない。
 *   それは遅れ(総時間不足)であって、判定できなかった訳ではない。
 *   混ぜると explain 側で原因を分けられなくなる(S08 と S16 の違いが消える)。
 */
function classifyUnresolved(state) {
  const list = [];
  const lotIds = new Set();
  // 🚨 ロットごとに「なぜ判定できなかったか」を持つ。これが無いと
  //   『判定できなかった』を『遅れる』に落としてしまう(2026-08-22 実測: 41件)。
  const lotReasons = new Map();
  const unresolvedIds = new Set();
  const lotUnitGate = new Map();  // lotId -> 手が付かなかった台の工程の一番小さい工程順

  const anyWorkTime = state.workerNames.some((n) => workMsInWindow(state, n) > 0);

  for (const job of state.jobs) {
    if (state.doneJobIds.has(job.jobId)) continue;
    if (state.endMsByJob.has(job.jobId)) continue;   // 手は付いている(期間の外まで走っている)

    let reason = null;
    if (job.durationKnown === false || finite(job.durationMs) == null) {
      reason = UNRESOLVED_REASON.DURATION_UNKNOWN;     // S16
    } else if (finite(job.arrivalMs) == null) {
      reason = UNRESOLVED_REASON.ARRIVAL_UNKNOWN;
    } else if (state.pins.has(job.lotId) && state.pins.get(job.lotId) === '') {
      reason = UNRESOLVED_REASON.PINNED_NONE;            // 📌 手で外した
    } else if (state.pins.has(job.lotId) && !eligibleOf(state, job.processKey).names.includes(state.pins.get(job.lotId))) {
      reason = UNRESOLVED_REASON.PINNED_NOT_ELIGIBLE;    // 📌 固定した人に記録が無い
    } else if (lockOf(job, state.planJobLocks) && !eligibleOf(state, job.processKey).names.includes(lockOf(job, state.planJobLocks).worker)) {
      reason = UNRESOLVED_REASON.PINNED_NOT_ELIGIBLE;
    } else {
      const names = eligibleOf(state, job.processKey).names.filter((n) => state.rosterSet.has(n));
      if (names.length === 0) reason = UNRESOLVED_REASON.NO_CANDIDATE;
      else if (!anyWorkTime) reason = UNRESOLVED_REASON.NO_WORK_TIME;
      else if (names.every((n) => workMsInWindow(state, n) === 0)) { state.currentAwayLotId = job.lotId; reason = allAwayReason(state, names); }
    }

    if (reason == null && job.afterJobId && unresolvedIds.has(job.afterJobId)) {
      reason = UNRESOLVED_REASON.PREV_UNRESOLVED;
    }
    if (reason == null && (job.unitIndex === null || job.unitIndex === undefined)) {
      const gate = lotUnitGate.get(job.lotId);
      const n = finite(job.stepIndex);
      if (gate != null && n != null && gate < n) reason = UNRESOLVED_REASON.PREV_UNRESOLVED;
    }
    if (reason == null) continue;

    unresolvedIds.add(job.jobId);
    lotIds.add(job.lotId);
    let rs = lotReasons.get(job.lotId);
    if (!rs) { rs = new Set(); lotReasons.set(job.lotId, rs); }
    rs.add(reason);
    if (job.unitIndex !== null && job.unitIndex !== undefined) {
      const n = finite(job.stepIndex);
      const cur = lotUnitGate.get(job.lotId);
      if (n != null && (cur == null || n < cur)) lotUnitGate.set(job.lotId, n);
    }
    list.push({ jobId: job.jobId, reason });
  }
  return { list, lotIds, lotReasons };
}

/**
 * 働けない理由(calendar.unavailableReason の記号) → 待機の理由の言葉。働ける時は null。
 * 🚨 3か所(替わった理由の note / idleReasonFor / idleReasonAt)が同じ表を引く。ここ1本で言い分ける。
 */
function unavailableIdleReason(un) {
  if (un === 'off') return IDLE_REASON.OFF;
  if (un === 'other-work') return IDLE_REASON.OTHER_WORK;
  if (un === 'roster-unknown') return IDLE_REASON.ROSTER_UNKNOWN;
  if (un === 'support-product') return IDLE_REASON.SUPPORT_PRODUCT;   // 👥 配置で製品検査の応援
  if (un === 'support-final') return IDLE_REASON.SUPPORT_FINAL;       // 👥 配置で最終検査の応援
  if (un) return IDLE_REASON.OUT_OF_HOURS;   // 土日・始業前・休憩・終業後
  return null;
}

const ymdLocalOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * 👥 2026-09-16 候補が全員「この期間に働ける時間0」の時、その理由を書き分ける。
 *   清水さん「休みじゃなくて、他のグループ応援してるが正しいよね、ちゃんとどのグループ応援してるか記載して」
 *   🚨 元データ(暦の休みの表の記号)に在る事だけ言う。**全員が同じ工場の応援** なら その工場の名前、
 *     それ以外(休みと応援が混ざる・応援先が割れる・記号が無い)は今までの『ずっと休み』のまま(推測で埋めない)。
 *   🚨 見るのは暦そのもの(state.calendar.spec.absences)。計算が0分と数えた同じ元を読む(別の表から数え直さない)。
 */
/** 休みの表の記号 → 人が読む言葉。知らない記号は そのまま出す(推測で丸めない)。 */
const AWAY_STATUS_LABEL = Object.freeze({
  off: '休み', other: '他の作業', 'support:product': '製品検査の応援', 'support:final': '最終検査の応援',
});
function allAwayReason(state, names) {
  const spec = state.calendar && state.calendar.spec;
  const abs = spec && spec.absences && typeof spec.absences === 'object' ? spec.absences : null;
  const isWorkday = typeof state.calendar.isWorkday === 'function' ? state.calendar.isWorkday : null;
  const ymds = [];
  const first = new Date(state.startNow); first.setHours(0, 0, 0, 0);
  for (let t = first.getTime(); t < state.horizonEnd && ymds.length < 400; t += 86400000) {
    if (isWorkday && !isWorkday(t)) continue;
    ymds.push(ymdLocalOf(t));
  }
  // 候補ごと: この期間の営業日に付いている記号の集合(記号の無い日は数えない。今日の残りが無い等、記号と関係ない0分が混ざる)
  const perName = names.map((n) => {
    const set = new Set();
    if (abs) for (const ymd of ymds) { const day = abs[ymd]; const s = day && typeof day === 'object' ? String(day[n] || '') : ''; if (s) set.add(s); }
    return { name: n, statuses: [...set] };
  });
  const detail = perName.map((p) => `${p.name}＝${p.statuses.length ? p.statuses.map((s) => AWAY_STATUS_LABEL[s] || s).join('・') : 'この期間に勤務の記号なし'}`).join('／');
  const allSame = (status) => perName.length > 0 && perName.every((p) => p.statuses.length === 1 && p.statuses[0] === status);
  if (allSame('support:product')) return UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_PRODUCT;
  if (allSame('support:final')) return UNRESOLVED_REASON.ALL_CANDIDATES_SUPPORT_FINAL;
  // 全員が同じ応援先なら理由の文に工場名が入るので、説明は 休みと応援が混ざる時(この枝)だけ添える(同じ事を2回言わない)
  if (!state.awayDetailByLot) state.awayDetailByLot = new Map();
  state.awayDetailByLot.set(state.currentAwayLotId, detail);
  return UNRESOLVED_REASON.ALL_CANDIDATES_AWAY;
}
function workMsInWindow(state, name) {
  if (state.workMsCache.has(name)) return state.workMsCache.get(name);
  const v = state.calendar.workMsBetween(state.startNow, state.horizonEnd, name);
  state.workMsCache.set(name, v);
  return v;
}

function buildLotResults(state, lotReasons) {
  const out = [];
  for (const lot of state.normalized.lots) {
    const jobs = state.jobsByLot.get(lot.lotId) || [];
    let allPlaced = true;
    let maxEnd = null;
    for (const job of jobs) {
      const end = state.endMsByJob.get(job.jobId);
      if (end == null) { allPlaced = false; continue; }
      if (maxEnd == null || end > maxEnd) maxEnd = end;
    }
    // 残っている仕事が1件も無いロットは、この期間に手を付ける物が無い＝もう終わっている。
    const finishMs = jobs.length === 0 ? state.startNow : (allPlaced ? maxEnd : null);

    const dueLineMs = lot.dueLineMs == null ? null : lot.dueLineMs;
    const reasons = lotReasons.get(lot.lotId) || null;
    const blocked = pickBlockedReason(reasons);
    // 今日の事実。日を進めても増えない。
    const alreadyPastDue = dueLineMs != null && dueLineMs < state.startNow;

    // 🚨🚨 2026-08-22 清水さんに3回続けて違う件数を出した原因はここ。
    //   「判定できなかった」を「遅れる」に落としていた。実測: 282件のうち **41件** が
    //   finishMs=null / lateMs=null のまま late=true になっていた。
    //   その41件は能力が足りないのではなく、**やった記録が無い / 目標時間が無い** ので
    //   そもそも配置できず、終わりの時刻が出せなかっただけ。
    //   → judgeable=false として遅れから外し、理由を持たせる。原因は explain が分ける。
    let judgeable = true;
    let unknownReason = null;
    if (dueLineMs == null) {
      judgeable = false;
      unknownReason = UNJUDGEABLE.NO_DUE;
    } else if (finishMs == null && blocked != null && INPUT_MISSING_REASONS.has(blocked)) {
      // 🚨 判定できないのは **入力が足りない時だけ**。
      //   「やった記録が無い」「候補が全員休み」は入力の問題ではなく、この見立てでは
      //   回せる人がいないという **結果** なので、遅れとして数える(指示書5.7 の技能不足)。
      //   ここを広く取ると S07(候補が休み) と S21(後継者なし) が突破しなくなり、
      //   「人が足りないのに守れる」と出る = 一番危ない嘘になる。
      judgeable = false;
      unknownReason = blocked;
    }

    let lateMs = null;
    let late = false;
    if (judgeable && dueLineMs != null) {
      if (finishMs != null) {
        lateMs = Math.max(0, finishMs - dueLineMs);
        late = lateMs > 0;
      } else if (dueLineMs <= state.horizonEnd) {
        // 配置はできたのに、この期間の中では終わらなかった＝時間が足りない。これは本物の遅れ。
        // いつ終わるかは分からないので lateMs は入れない。
        // 🚨 ここに「期間の終わり − 納期線」を入れると、見ていない先の話を数字にしてしまう。
        late = true;
      }
      // 納期線が期間より先なら、この5日の中では判定できない。late のままにしない。
    }
    // 👥 このロットの中で人が替わった記録(なぜ分担したか)。
    //   🚨 1件も無いロットは **鍵ごと出さない**。出すと結果の形が変わる。
    //   ⚠ 画面(opsim/DueCalendar.jsx)は handoff.splits[].why をそのまま札に出す。
    //     ここで文を作り直さない(同じ文を2か所から出さない)。
    const splits = state.unitSplits.get(lot.lotId) || null;
    // 🧵 人がこのロットを離れた記録(なぜ次のロットへ？)。**離れた元のロット** に載せる。
    //   🚨 1件も無いロットは鍵ごと出さない。lotFocus が切ってあれば1件も積まれないので、形は変わらない。
    //   ⚠ 画面(PersonDay の data-row-lot-switch-why)は lotSwitches[].why をそのまま出す。ここで文を作らない。
    const lotSwitches = state.lotSwitches.get(lot.lotId) || null;
    out.push({
      lotId: lot.lotId,
      finishMs,
      dueLineMs,
      lateMs,
      late,
      alreadyPastDue,
      judgeable,
      unknownReason,
      blocked,
      // 👥 2026-09-16 候補ごとの「なぜ居ないか」(村＝最終検査の応援／信濃＝休み)。無ければ null。画面はこの文をそのまま出す。
      // 🧵 2026-09-17 始めない理由(出来る人が居ない工程)が在れば それ。無ければ 休みの内訳。
      blockedDetail: (state.unfinishableDetail && state.unfinishableDetail.get(lot.lotId))
        || (state.awayDetailByLot && state.awayDetailByLot.get(lot.lotId)) || null,
      ...(splits && splits.length ? { handoff: { mode: state.handoff, splits } } : {}),
      ...(lotSwitches && lotSwitches.length ? { lotSwitches } : {}),
    });
  }
  return out;
}
