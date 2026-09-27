// =============================================================================
//  🔁 setupChange.js — 段取り替え(前と違う型式を始めた時、最初の1回に余計にかかる時間)
// -----------------------------------------------------------------------------
//  いまの割付(simulate.js)は、同じ人が同じ型式を続けても、型式を切り替えても、
//  同じ目標時間で計算している。実際は切り替えた最初の1回に段取りの時間が乗る。
//  その差は lot.tasks の実測から数えられる(型式は lot.model に入っている)。
//
//  🚨 このファイルが守る事:
//    ① **前の型式が分からない時は 0**。「たぶん切り替えただろう」で足さない。
//       その人の記録がこれが最初／前の作業から間が空きすぎている、は どちらも「分かりません」。
//    ② **件数が足りない工程には数字を作らない**(enough:false・extraSecMedian は出すが使わない)。
//    ③ **既定は off**。setupExtraSec に mode を渡さなければ 1秒も足さない。
//    ④ 差が **マイナス**(切り替えた方が短い)に出た工程は、足し引き 0 にする。
//       ⚠ 測った値そのもの(raw)は消さずに残す。「切り替えると速くなる」は現場の実感と合わないが、
//         記録がそう言っている事実は隠さない。
//    ⑤ **土台に何が入っているかを言わせてから足す**(2026-09-10 の指摘で足した)。
//       割付の目標時間は estimate.js の中央値で、そこには「型式が変わった直後の記録」も
//       混ざっている。そこへ「続きの真ん中との差」を丸ごと足すと **切り替えの分を2回数える**。
//       ・setupExtraSec は baseKind を受け取る(既定 'mixed' = いまの目標時間)
//       ・'mixed' には、混ぜた真ん中との差 extraOverMixedSec を足す(重なりぶんを引いた値)
//       ・素の土台('sameModelOnly')へ足す呼ぶ側だけ extraSecMedian を丸ごと使う
//       ・知らない baseKind を渡されたら 0(土台が分からないまま足さない)
//       ⚠ どちらを選んだかの理由: 割付の土台(estimate.js)を作り替えるのは この8本の外の話で、
//         いま繋ぐと工数の出し方が2つになる。だから **土台は触らず、重なりぶんを引く** 方にした。
//

//  ⚠ ここには React も firebase も import しない(node --test で回すため)。
//  ⚠ 関数の中で Date.now() / Math.random() を呼ばない(同じ入力なら毎回同じ答え)。
//
// -----------------------------------------------------------------------------
//  本番の写しで測った事
//  (2026-09-10_0100 の写し・製品検査 603ロット / 作業の記録 7,423件。読むだけ)
// -----------------------------------------------------------------------------
//    並べられた記録 5,428件(やった人が1人に決まり、始めた時刻が入っている)
//      型式が変わった直後の1件 …………………………………………   708件
//      前と同じ型式の続き ……………………………………………… 4,569件
//      前の型式が分からない ……………………………………………   151件
//        (その人の最初の作業 / 前の作業の終わりから12時間より間があいた)
//    工程 172本 → **使える工程 27本**(切り替え側も続き側も 5件以上)
//    型式が変わった初回の余計な時間(その工程の「続き」の真ん中との差の中央値)
//      **工程をまたいでまとめると +22秒(0.4分)**  ※ まとめた 535件
//      工程ごとでは −63秒 〜 +361秒 / 真ん中 +34秒
//        「準備」が付く14工程 …… 0秒 〜 172秒 / 真ん中 +33秒
//        一番長い「分割自動測定開始」…… +361秒(6.0分・11件)
//      ⚠ 7工程は差が 0以下(記録上は切り替えた方が短い)。上の④のとおり 0 にして使う。
//    効き方: 未完了 180ロットに1回ずつ乗せると +1.1時間。
//            残り 211.0時間(工程の全体中央値で見積もった量)の **0.5%**。
//    ⑤の重なりを引くと(2026-09-10 に数え直した・同じ写し):
//      まとめた値 …………… 22秒 → **15秒**
//      使える27工程の合計 … 1,545秒 → **1,332秒**(−13.8%)
//      1工程だけ、続き基準では余計にかかるのに 混ぜた基準では 0秒 になった
//      ⚠ 逆に「切り替えた方が短い」5工程(片付け・直角度測定・準備・測定準備・最終片付け)では、
//        短い記録が混ざるので 混ぜた土台の方が **低く** 出る。どちらの差も④で 0 に丸まるので
//        足す秒は 0 のまま。「混ぜた土台は必ず高い」とは限らない事だけ覚えておく
//      いちばん長い「分割自動測定開始」は 361秒 → 361秒(この工程は切り替えの記録が11件・
//        続きが243件なので、混ぜても真ん中がほとんど動かない = 二重に数えていた分が小さい)
//      盤に載っている 176ロット(dueDefense.isOpenLot)に1回ずつなら 1.08時間 → **0.73時間**
//    ⚠ 「初回準備」は そもそも新しいロットの1本目なので、
//      「同じ型式の続き」の記録が 5件しかない(89件 対 5件)。件数の関所が要る所。
// =============================================================================

import { resolveTaskProcess, processKeyOf } from '../soloDependency.js';
import { taskTimeQualityOf } from '../taskTimeQuality.js';
import { taskDurationSec, ACCEPTED_QUALITY, MIN_SAMPLE_FOR_HIGH, percentile } from './estimate.js';

const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/** 中央値。⚠ estimate.js の分位点(線形補間)をそのまま使う。ここで別の数え方をしない。 */
export const medianOfSec = (values) => percentile(values, 0.5);

/** 前の作業からこれ以上あいたら「前の型式は分かりません」。既定 12時間(日をまたいだら別)。 */
export const DEFAULT_MAX_GAP_MS = 12 * 3600 * 1000;

/**
 * 型式の見分け方(既定)。
 * ⚠ 本番の model は `"RWA-160L,RE,P"` の様に付属の記号まで入っている。
 *   ここでは **文字列をそのまま** 比べる。頭だけで束ねると別の機械を同じ型式と数えてしまう。
 *   束ね方を変えたい時は modelKeyOf を渡す(渡さなければ何も変わらない)。
 */
export const defaultModelKeyOf = (model) => trimmed(model);

/** 時刻を ms に。⚠0 と負は「入っていない」として捨てる(1970年に化けさせない)。 */
export const msOf = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'object' && typeof v.seconds === 'number') {
    const ms = v.seconds * 1000 + Math.round((v.nanoseconds || 0) / 1e6);
    return ms > 0 ? ms : null;
  }
  const t = new Date(v).getTime();
  return Number.isFinite(t) && t > 0 ? t : null;
};

/**
 * 1件の作業を「やった人」の名前。2人以上で分けた記録は決めない(null)。
 * ⚠ workerSpeed.js の soleWorkerNameOf と同じ決め方。片方だけ変えない事。
 */
export const soleWorkerNameOf = (task) => {
  const names = new Set();
  for (const s of asArray(task && task.sessions)) {
    if (!isObj(s)) continue;
    const n = trimmed(s.workerName);
    if (n) names.add(n);
  }
  const own = trimmed(task && task.workerName);
  if (own) names.add(own);
  if (names.size !== 1) return null;
  return [...names][0];
};

/** 教育中として記録された作業か(物差しから外す)。 */
export const isTraineeTask = (task) => !!task && task.trainee === true;

// -----------------------------------------------------------------------------
//  1. 実測から「余計にかかる時間」を数える
// -----------------------------------------------------------------------------
/**
 * 本番の記録から「型式を切り替えた最初の1回に、どれだけ余計にかかったか」を数える。
 *
 * 数え方:
 *   ① 人ごとに、作業を **始めた時刻の順** に並べる
 *   ② となり合う2件を見て、型式が変わっていれば「切り替え直後」、同じなら「続き」
 *      ⚠ 前の作業の終わりから maxGapMs より間があいたら「前の型式は分かりません」(どちらにも数えない)
 *   ③ 工程ごとに「続き」の真ん中の時間を出し、「切り替え直後」の各件との差を取る
 *   ④ その差の真ん中が、その工程の「余計にかかった時間」
 *
 * 🚨 lots を渡さなければ **1行も動かない**。
 *
 * @param {object} args
 * @param {Array}  args.lots ロット(完了ロットも入れる)
 * @param {number} [args.minSamples=5] 工程ごとにこの件数から使う(切り替え側・続き側の両方)
 * @param {number} [args.maxGapMs=43200000] 前の作業からこれ以上あいたら「分かりません」
 * @param {Function} [args.modelKeyOf] 型式の見分け方
 * @param {string[]} [args.acceptStatuses=['completed']]
 * @param {string[]} [args.acceptedQuality] 既定は estimate.js の ACCEPTED_QUALITY
 * @returns {{ byStep: object, all: object, warnings: string[], diagnostics: object, minSamples: number }}
 *   byStep … 鍵は processKeyOf(templateId, stepId)
 *     { stepKey, title, n, baseN, baseMedianSec, extraSecMedian, extraSecRaw, enough, why }
 *     n              … 型式が変わった直後の記録の件数
 *     baseN          … 同じ型式を続けた記録の件数
 *     extraSecMedian … 余計にかかった秒(マイナスは 0 にした後の値)
 *     extraSecRaw    … 測ったままの秒(マイナスも残す)
 *   all  … 工程をまたいで まとめた1件(同じ形)
 */
export function buildSetupChange({
  lots,
  minSamples = MIN_SAMPLE_FOR_HIGH,
  maxGapMs = DEFAULT_MAX_GAP_MS,
  modelKeyOf = defaultModelKeyOf,
  acceptStatuses = ['completed'],
  acceptedQuality = ACCEPTED_QUALITY,
} = {}) {
  const warnings = [];
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');
  const okQ = new Set(asArray(acceptedQuality).map((v) => str(v).trim()).filter(Boolean));
  if (okQ.size === 0) ACCEPTED_QUALITY.forEach((q) => okQ.add(q));
  const minN = Number.isInteger(Number(minSamples)) && Number(minSamples) >= 1 ? Number(minSamples) : MIN_SAMPLE_FOR_HIGH;
  const gapCap = Number.isFinite(Number(maxGapMs)) && Number(maxGapMs) > 0 ? Number(maxGapMs) : DEFAULT_MAX_GAP_MS;
  const keyOfModel = typeof modelKeyOf === 'function' ? modelKeyOf : defaultModelKeyOf;

  const diagnostics = {
    lotsSeen: 0, tasksSeen: 0,
    droppedStatus: 0, droppedStep: 0, droppedDuration: 0, droppedQuality: 0,
    droppedTrainee: 0, droppedHandoff: 0, droppedNoWorker: 0, droppedNoStart: 0, droppedNoModel: 0,
    ordered: 0, changed: 0, same: 0, unknownPrev: 0,
  };

  const list = asArray(lots);
  if (list.length === 0) {
    warnings.push('ロットが1件も渡されていません。段取り替えの時間は何も出しません。');
    return { byStep: {}, all: emptyAll(), warnings, diagnostics, minSamples: minN };
  }

  /** 人 -> 記録の配列 */
  const byWorker = new Map();
  const titleOf = new Map();

  for (const lot of list) {
    if (!isObj(lot)) continue;
    diagnostics.lotsSeen += 1;
    const steps = asArray(lot.steps);
    const templateId = str(lot.templateId);
    const model = keyOfModel(lot.model);
    const tasks = isObj(lot.tasks) ? lot.tasks : {};
    for (const [taskKey, task] of Object.entries(tasks)) {
      if (!isObj(task)) continue;
      diagnostics.tasksSeen += 1;
      if (!ok.has(str(task.status))) { diagnostics.droppedStatus += 1; continue; }
      if (isTraineeTask(task)) { diagnostics.droppedTrainee += 1; continue; }
      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) { diagnostics.droppedStep += 1; continue; }
      const sec = taskDurationSec(task);
      if (sec == null) { diagnostics.droppedDuration += 1; continue; }
      const q = str((taskTimeQualityOf(task) || {}).quality) || 'missing';
      if (!okQ.has(q)) { diagnostics.droppedQuality += 1; continue; }
      const names = new Set();
      for (const s of asArray(task.sessions)) { const n = trimmed(s && s.workerName); if (n) names.add(n); }
      const own = trimmed(task.workerName);
      if (own) names.add(own);
      if (names.size === 0) { diagnostics.droppedNoWorker += 1; continue; }
      if (names.size > 1) { diagnostics.droppedHandoff += 1; continue; }
      if (!model) { diagnostics.droppedNoModel += 1; continue; }
      const startMs = msOf(task.firstStartTime) ?? msOf(task.startTime);
      const endMs = msOf(task.endTime);
      // 並べるには「始めた時刻」が要る。終わりしか無い時は 終わり − かかった時間 で置く。
      const start = startMs ?? (endMs != null ? endMs - sec * 1000 : null);
      if (start == null) { diagnostics.droppedNoStart += 1; continue; }
      const end = endMs ?? (start + sec * 1000);

      const worker = [...names][0];
      const stepKey = processKeyOf(templateId, str(r.stepId));
      if (!titleOf.has(stepKey)) titleOf.set(stepKey, str(r.step && r.step.title));
      let arr = byWorker.get(worker);
      if (!arr) { arr = []; byWorker.set(worker, arr); }
      arr.push({ worker, stepKey, model, sec, start, end, id: `${str(lot.id ?? lot.__id)}#${str(taskKey)}` });
      diagnostics.ordered += 1;
    }
  }

  // ── となり合う2件を見る ────────────────────────────────────────────────
  /** stepKey -> { changed: [{sec}], same: [sec] } */
  const perStep = new Map();
  for (const [, arr] of byWorker) {
    // 🚨 並べ替えは必ず 同じ答えになる形にする(始めた時刻 → 終わり → 記録の身元)。
    //    時刻が同じ2件の順番が入れ替わると、切り替え直後の1件が別の件になる。
    arr.sort((a, b) => (a.start - b.start) || (a.end - b.end) || a.id.localeCompare(b.id));
    let prev = null;
    for (const cur of arr) {
      let bucket = null;
      if (prev == null) bucket = 'unknown';
      else if (cur.start - prev.end > gapCap) bucket = 'unknown';
      else bucket = (cur.model === prev.model) ? 'same' : 'changed';
      prev = cur;
      if (bucket === 'unknown') { diagnostics.unknownPrev += 1; continue; }
      let e = perStep.get(cur.stepKey);
      if (!e) { e = { changed: [], same: [] }; perStep.set(cur.stepKey, e); }
      if (bucket === 'changed') { e.changed.push(cur.sec); diagnostics.changed += 1; }
      else { e.same.push(cur.sec); diagnostics.same += 1; }
    }
  }

  // ── 工程ごとの余計な時間 ───────────────────────────────────────────────
  // 🚨 土台を2つ数える(2026-09-10 の指摘。⑤ を参照)。
  //   ・baseMedianSec  … 「同じ型式の続き」だけの真ん中 = 素の土台
  //   ・mixedMedianSec … 続き + 切り替え直後 を混ぜた真ん中 = estimate.js が出す土台に近い形
  //   割付が使っているのは後者なので、後者へ足す時は差の取り方も後者に合わせる。
  const byStep = {};
  const allExtras = [];
  const allExtrasMixed = [];
  let allChanged = 0, allBase = 0, stepsUsed = 0;
  for (const [stepKey, e] of perStep) {
    const baseMedianSec = medianOfSec(e.same);
    const mixedMedianSec = medianOfSec(e.same.concat(e.changed));
    const n = e.changed.length;
    const baseN = e.same.length;
    const enough = n >= minN && baseN >= minN && baseMedianSec != null;
    const extras = (baseMedianSec == null) ? [] : e.changed.map((s) => s - baseMedianSec);
    const extrasMixed = (mixedMedianSec == null) ? [] : e.changed.map((s) => s - mixedMedianSec);
    const raw = extras.length ? medianOfSec(extras) : null;
    const rawMixed = extrasMixed.length ? medianOfSec(extrasMixed) : null;
    const used = enough && raw != null;
    byStep[stepKey] = {
      stepKey,
      title: titleOf.get(stepKey) || '',
      n, baseN,
      baseMedianSec,
      mixedMedianSec,
      extraSecRaw: raw,
      // ④ マイナスは足し引き 0(引き算はしない)。測った値は extraSecRaw に残す。
      extraSecMedian: used ? Math.max(0, Math.round(raw)) : null,
      extraOverMixedRaw: rawMixed,
      // ⑤ 混ぜた土台へ足す時の秒。切り替え直後の記録が既に土台へ入っている分を引いてある。
      extraOverMixedSec: (used && rawMixed != null) ? Math.max(0, Math.round(rawMixed)) : null,
      enough: used,
      why: used
        ? `型式が変わった直後 ${n}件 と 同じ型式の続き ${baseN}件（真ん中 ${Math.round(baseMedianSec)}秒）との差の真ん中が ${Math.round(raw)}秒`
          + (raw < 0 ? '（マイナスなので 0 にしました）' : '')
          + (rawMixed != null
            ? `。両方を混ぜた真ん中 ${Math.round(mixedMedianSec)}秒 との差なら ${Math.round(rawMixed)}秒`
            : '')
        : `型式が変わった直後 ${n}件・続き ${baseN}件（どちらも ${minN}件から使います）`,
    };
    if (used) {
      stepsUsed += 1;
      allChanged += n;
      allBase += baseN;
      for (const x of extras) allExtras.push(x);
      for (const x of extrasMixed) allExtrasMixed.push(x);
    }
  }

  const allRaw = allExtras.length ? medianOfSec(allExtras) : null;
  const allRawMixed = allExtrasMixed.length ? medianOfSec(allExtrasMixed) : null;
  const allEnough = allExtras.length >= minN && allRaw != null;
  const all = {
    stepKey: null,
    title: '（工程をまたいで まとめて）',
    n: allChanged,
    baseN: allBase,
    steps: stepsUsed,
    baseMedianSec: null,
    mixedMedianSec: null,
    extraSecRaw: allRaw,
    extraSecMedian: allEnough ? Math.max(0, Math.round(allRaw)) : null,
    extraOverMixedRaw: allRawMixed,
    extraOverMixedSec: (allEnough && allRawMixed != null) ? Math.max(0, Math.round(allRawMixed)) : null,
    enough: allEnough,
    why: allEnough
      ? `${stepsUsed}工程・型式が変わった直後 ${allChanged}件の差の真ん中が ${Math.round(allRaw)}秒`
        + (allRaw < 0 ? '（マイナスなので 0 にしました）' : '')
        + (allRawMixed != null ? `。混ぜた土台との差なら ${Math.round(allRawMixed)}秒` : '')
      : `まとめられた記録が ${allExtras.length}件です（${minN}件から使います）`,
  };

  if (diagnostics.unknownPrev > 0) {
    warnings.push(`前の型式が分からない記録 ${diagnostics.unknownPrev}件は、どちらにも数えていません（その人の最初の作業、または前の作業から ${Math.round(gapCap / 3600000)}時間より間があいた記録）。`);
  }
  if (diagnostics.droppedTrainee > 0) {
    warnings.push(`教育中として記録された作業 ${diagnostics.droppedTrainee}件を物差しから外しました。`);
  }
  if (diagnostics.droppedNoModel > 0) {
    warnings.push(`型式が入っていないロットの作業 ${diagnostics.droppedNoModel}件を外しました。`);
  }
  if (diagnostics.ordered === 0) {
    warnings.push('段取り替えを数えられる記録が1件もありませんでした。');
  }

  return { byStep, all, warnings, diagnostics, minSamples: minN };
}

const emptyAll = () => ({
  stepKey: null, title: '（工程をまたいで まとめて）', n: 0, baseN: 0, steps: 0,
  baseMedianSec: null, mixedMedianSec: null,
  extraSecRaw: null, extraSecMedian: null,
  extraOverMixedRaw: null, extraOverMixedSec: null,
  enough: false,
  why: '記録がありません',
});

// -----------------------------------------------------------------------------
//  2. 割付で使う(1件ぶんへ足す)
// -----------------------------------------------------------------------------
/** 足し方。⚠ 既定は off。渡さなければ 1秒も足さない。 */
export const SETUP_MODE = Object.freeze({
  /** 切ってある */
  OFF: 'off',
  /** 工程ごとの実測。無ければ まとめた値。どちらも無ければ足さない */
  BY_STEP: 'byStep',
  /** まとめた値だけ */
  ALL: 'all',
});

/**
 * 上乗せする相手(土台)の種類。
 *
 * 🚨🚨 2026-09-10 の指摘: 上乗せの土台が二重だった。
 *   割付が使う目標時間(estimate.js の中央値)は、**型式が変わった直後の記録も混ぜた** 真ん中。
 *   そこへ「続きの真ん中との差」を丸ごと足すと、切り替えの分を2回数える事になる。
 *   applyReworkRate は「task.duration に修正の時間は入っていない」と確かめた上で足している。
 *   ここも同じ考え方で、**土台に何が入っているか** を呼ぶ側に言わせてから足す。
 *
 *   MIXED          … 続きも切り替えも混ざった真ん中(= estimate.js が出す物)。
 *                    重なりぶんを引いた extraOverMixedSec を足す。**既定はこちら**
 *   SAME_MODEL_ONLY… 「同じ型式の続き」だけで作った素の土台。extraSecMedian を丸ごと足す
 *
 * ⚠ 正直に書いておく: ここで数える「混ぜた真ん中」は、estimate.js が使う母集団と
 *   **ぴったり同じではない**。段取り替えを並べる為に、やった人が決まらない記録・
 *   始めた時刻が無い記録を落としているので、その分だけ母集団が小さい。
 *   だから引き算も近似。**近似だと分かった上で、二重に数えるよりは近い方を選ぶ**。
 */
export const BASE_KIND = Object.freeze({
  MIXED: 'mixed',
  SAME_MODEL_ONLY: 'sameModelOnly',
});

/**
 * 「前と違う型式を始めた」時に足す秒。
 *
 * 🚨 mode を渡さなければ 0(既定 off)。
 * 🚨 前の型式が分からない時は 0。勝手に足さない。
 * 🚨 baseKind を知らない字で渡されたら 0。土台が何か分からないまま足さない。
 *
 * @param {object} args
 * @param {string} args.prevModel その人が直前にやっていた型式（空 = 分かりません）
 * @param {string} args.nextModel これから始める型式
 * @param {string} args.stepKey processKeyOf(templateId, stepId)。job.processKey と同じ物
 * @param {object} args.setup buildSetupChange の戻り
 * @param {string} [args.mode='off']
 * @param {string} [args.baseKind='mixed'] 足す相手の土台の種類(BASE_KIND)
 * @param {Function} [args.modelKeyOf] 型式の見分け方(buildSetupChange と同じ物を渡す事)
 * @returns {{ sec:number, applied:boolean, why:string, source:string, n:number, baseKind:string }}
 *   source … 'off' | 'byStep' | 'all' | 'none'
 */
export function setupExtraSec({
  prevModel, nextModel, stepKey, setup, mode = SETUP_MODE.OFF,
  baseKind = BASE_KIND.MIXED, modelKeyOf = defaultModelKeyOf,
} = {}) {
  const m = str(mode);
  const bk = str(baseKind);
  if (m !== SETUP_MODE.BY_STEP && m !== SETUP_MODE.ALL) {
    return { sec: 0, applied: false, why: '段取り替えの時間は切ってあります', source: 'off', n: 0, baseKind: bk };
  }
  if (bk !== BASE_KIND.MIXED && bk !== BASE_KIND.SAME_MODEL_ONLY) {
    return {
      sec: 0, applied: false,
      why: `足す相手の土台が分かりません（${bk || '空'}）。二重に数えない為、足しません`,
      source: 'none', n: 0, baseKind: bk,
    };
  }
  const keyOfModel = typeof modelKeyOf === 'function' ? modelKeyOf : defaultModelKeyOf;
  const prev = keyOfModel(prevModel);
  const next = keyOfModel(nextModel);
  if (!prev) {
    return { sec: 0, applied: false, why: '前の型式が分かりません（余計な時間は足しません）', source: 'none', n: 0, baseKind: bk };
  }
  if (!next) {
    return { sec: 0, applied: false, why: 'これから始める型式が分かりません（余計な時間は足しません）', source: 'none', n: 0, baseKind: bk };
  }
  if (prev === next) {
    return { sec: 0, applied: false, why: `前と同じ型式（${next}）の続きです`, source: 'none', n: 0, baseKind: bk };
  }
  const byStep = (setup && isObj(setup.byStep)) ? setup.byStep : {};
  const all = (setup && isObj(setup.all)) ? setup.all : null;

  // 🚨 土台に合った秒を選ぶ。混ぜた土台には、重なりぶんを引いた方を足す。
  const secOf = (e) => (bk === BASE_KIND.MIXED ? e.extraOverMixedSec : e.extraSecMedian);
  const label = bk === BASE_KIND.MIXED
    ? '（切り替えの記録も混ざった目標時間へ足すので、重なるぶんを引いてあります）'
    : '（同じ型式の続きだけで作った目標時間へ足します）';

  if (m === SETUP_MODE.BY_STEP) {
    const e = byStep[str(stepKey)];
    const v = e ? secOf(e) : null;
    if (e && e.enough && Number.isFinite(v)) {
      return {
        sec: Math.max(0, Math.round(v)),
        applied: v > 0,
        why: `${prev} → ${next} の切り替え。この工程 ${e.n}件の記録から ${Math.round(v)}秒${label}`,
        source: 'byStep', n: e.n, baseKind: bk,
      };
    }
  }
  const av = all ? secOf(all) : null;
  if (all && all.enough && Number.isFinite(av)) {
    return {
      sec: Math.max(0, Math.round(av)),
      applied: av > 0,
      why: `${prev} → ${next} の切り替え。まとめた ${all.n}件の記録から ${Math.round(av)}秒${label}`,
      source: 'all', n: all.n, baseKind: bk,
    };
  }
  return {
    sec: 0, applied: false,
    why: `${prev} → ${next} の切り替えですが、この工程の記録が足りません（足しません）`,
    source: 'none', n: 0, baseKind: bk,
  };
}

/** 画面に出す1行(工程ごと)。⚠ 数字はここまでで数えた物だけ。手書きしない。 */
export const setupChangeRows = (setup) => {
  const src = (setup && isObj(setup.byStep)) ? setup.byStep : {};
  return Object.values(src)
    .map((e) => ({
      stepKey: e.stepKey,
      title: e.title,
      n: e.n,
      baseN: e.baseN,
      extraSecMedian: e.extraSecMedian,
      // 🚨 画面にも両方出す。「素の土台との差」と「いまの目標時間へ足す秒」は別物。
      extraOverMixedSec: e.extraOverMixedSec,
      enough: e.enough,
      note: e.enough
        ? `型式が変わった初回 ${e.n}件。続き ${e.baseN}件の真ん中より ${(e.extraSecMedian / 60).toFixed(1)}分 余計`
          + (Number.isFinite(e.extraOverMixedSec)
            ? `（いまの目標時間へ足すのは、重なるぶんを引いた ${(e.extraOverMixedSec / 60).toFixed(1)}分）`
            : '')
        : e.why,
    }))
    .sort((a, b) => (b.n - a.n) || String(a.title).localeCompare(String(b.title), 'ja'));
};

export default buildSetupChange;
