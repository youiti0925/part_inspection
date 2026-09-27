// =============================================================================
//  👤 workerSpeed.js — 人ごとの速さ(その人はこの工程を、みんなの真ん中の何倍の時間で終えるか)
// -----------------------------------------------------------------------------
//  いまの割付(simulate.js)は **全員が同じ目標時間で働く** 前提で組んである。
//  実際は同じ工程でも人によって時間が違う。その差は lot.tasks の実測に既に入っている。
//
//  🚨 このファイルが守る事:
//    ① **測っていない人・工程に係数を作らない**。件数が足りない組は ratio:null。
//       1.0 で埋めない(1.0 は「みんなと同じ速さだと測れた」という別の意味になる)。
//    ② **1件の外れ値で倍速にしない**。係数は clamp(既定 0.5〜2.0倍)の外へ出さない。
//    ③ **教育中の記録(task.trainee === true)は物差しから外す**。
//       ⚠ 実費(かかった時間そのもの)からは外さない。App.jsx の isStatTask と同じ考え方。
//    ④ **1件の作業を2人で分けた記録(引き継ぎ)は、誰の速さか決められない**ので外す。
//       片方へ寄せると、その人だけ倍の時間がかかった事になる。
//    ⑤ **既定は off**。applyWorkerSpeed に mode を渡さなければ 1バイトも時間を変えない。
//
//  ⚠ ここには React も firebase も import しない(node --test で回すため)。
//  ⚠ 関数の中で Date.now() / Math.random() を呼ばない(同じ入力なら毎回同じ答え)。
//
// -----------------------------------------------------------------------------
//  本番の写しで測った事
//  (2026-09-10_0100 の写し・製品検査 603ロット / 作業の記録 7,423件。読むだけ)
// -----------------------------------------------------------------------------
//    使えた記録 5,428件 / 7,423件
//      外した内訳: 完了ではない 356件・工程が決まらない 45件・時間が入っていない 15件
//                  記録の質が 低信頼/記録不足 1,275件・やった人の名前が無い 304件
//                  引き継ぎ(2人で分けた) 0件・教育中 0件
//    人×工程 の組 309組 → **使える組 105組**(4人 / 53工程)
//      「使える」= その人 5件以上 かつ **その人以外** も 5件以上
//      ⚠ 比べる相手が居ないと比は必ず 1.00倍になる。だから相手側の件数も見る。
//    係数(その人の中央値 ÷ その工程の全体中央値)
//      最小 0.29倍 / P25 0.90 / 中央 1.00 / P75 1.07 / 最大 2.05倍
//      0.8倍より短い 12組・1.25倍より長い 8組
//      clamp(0.5〜2.0)に当たったのは 上限 1組・下限 4組
//      例) 信濃さん「測定結果を確認」10件 70秒 ÷ 全体 240秒 = 0.29倍
//          尾田さん「分割自動測定開始」40件 720秒 ÷ 全体 360秒 = 2.00倍
//    人ぜんぶの係数(工程ごとの倍率の真ん中)
//      村 0.75倍(8工程123件) / 尾田 1.00(17工程1596件) / 片山 1.00(44工程529件) / 信濃 1.01(36工程645件)
//      → **人ぜんぶで見ると差はほとんど無い。差は工程ごとに出ている。**
//    未完了180ロットの残り 3,237件 = 211.0時間(工程の全体中央値で見積もった量)に対して
//      過去と同じ割り当て方なら +1.1%(477.2時間 → 482.5時間・完了記録6,055件の写しで実測)
//      1人で全部やると 尾田 +2.0% / 信濃 +2.4% / 片山 −0.8% / 村 −22.8%
//    ⚠ task.trainee は写しに **1件も無い**(0/7,423件)。
//      画面で教育中の印を付け始めたら、その日から自動で物差しから外れる。
//    ⚠ 記録に出てくる名前は5つ(片山・尾田・信濃・村・管理者)だが、登録作業者は4人。
//      「管理者」は記録に混ざるが、件数が足りず係数は出ていない。
//
// -----------------------------------------------------------------------------
//  🚨🚨 mode:'workerStep' は **8割が「その人ぜんぶ」へ落ちる**(2026-09-10 の指摘)
// -----------------------------------------------------------------------------
//    以前ここには「人×工程が当たらない残りは目標時間のまま動きます」と書いてあったが、
//    それは実データでは成り立たない。落ち先が在るからで、目標時間には戻らない。
//    同じ写しで数え直した(まだ終わっていない 176ロットに残る 3,341件 × 記録の在る4人):
//      人×工程が当たる ……  2,671件 / 13,364件 = **20.0%**
//      その人ぜんぶへ落ちる 10,693件 / 13,364件 = **80.0%**
//      目標時間のまま ……         0件 = **0.0%**
//    落ち先は工程の差を見ていない一律の倍率で、村さんは 0.75倍。
//    つまり「工程ごとに測った速さで動きます」と言いながら、実際に効くのは
//    村さんの全工程 −25% だった。**落ちた事は必ず言う**:
//      ・applyWorkerSpeed の戻りに fellBack:true が立ち、why に「この工程ではなく〜ぜんぶ」と書く
//      ・落としたくない呼ぶ側は mode:'workerStepOnly' を渡す(その時だけ目標時間のまま)
//      ・画面へ出す前に workerSpeedSourceCounts で「何%が落ちるか」を数えて見せる
// =============================================================================

// 🚨 工程の当て方・所要秒の出し方・記録の質は **既存の物をそのまま** 使う。
//    自前で当て直すと estimate.js と鍵がズレて、別工程の時間を掴む。
import { resolveTaskProcess, processKeyOf } from '../soloDependency.js';
import { taskTimeQualityOf } from '../taskTimeQuality.js';
import { taskDurationSec, ACCEPTED_QUALITY, MIN_SAMPLE_FOR_HIGH, percentile } from './estimate.js';

const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/** 中央値。⚠ estimate.js の分位点(線形補間)をそのまま使う。ここで別の数え方をしない。 */
export const medianSec = (values) => percentile(values, 0.5);

/**
 * 「人 × 工程」の鍵。
 * 🚨 区切り文字を1つ決めて挟む方式にしない。名前や工程キーにその字が入らない事を
 *    「たぶん入らない」で済ませると、別々の組が同じ鍵に潰れる。
 *    先に**長さ**を書くので、どんな文字列でも1つの鍵にしかならない(processKeyOf と同じ作法)。
 */
export const workerStepKeyOf = (worker, stepKey) => {
  const w = str(worker);
  return `${w.length}:${w}:${str(stepKey)}`;
};

/**
 * 1件の作業を「やった人」の名前。
 * 🚨 引き継ぎ(1件を2人で分ける)が実在するので、2人以上なら **決めない**(null を返す)。
 *    ⚠ 名前で束ねる理由: 割付(simulate.js)が名前で人を選んでいるため、鍵をそろえる。
 *      同姓同名は名前では分かれない。そこは soloDependency.resolveWorkerName の担当。
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

/** 教育中として記録された作業か。⚠「今その人が教育中か」ではなく、その記録に付いた印。 */
export const isTraineeTask = (task) => !!task && task.trainee === true;

/** 係数を clamp の中へ入れる。⚠ 黙って丸めない(clamped を必ず一緒に返す)。 */
export const clampRatio = (raw, clamp) => {
  const lo = Number(Array.isArray(clamp) ? clamp[0] : NaN);
  const hi = Number(Array.isArray(clamp) ? clamp[1] : NaN);
  const r = Number(raw);
  if (!Number.isFinite(r) || r <= 0) return { ratio: null, clamped: false };
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) {
    // clamp の指定が読めない時は **掛けない**(制限なしで 6.75倍を通さない)。
    return { ratio: null, clamped: false };
  }
  if (r < lo) return { ratio: lo, clamped: true };
  if (r > hi) return { ratio: hi, clamped: true };
  return { ratio: r, clamped: false };
};

// -----------------------------------------------------------------------------
//  1. 実測から係数を作る
// -----------------------------------------------------------------------------
/**
 * 本番の記録から「人ごとの速さ」を数える。
 *
 * 🚨 lots を渡さなければ **1行も動かない**(空の表と、その旨の warnings だけ返す)。
 *
 * @param {object} args
 * @param {Array}  args.lots ロット(完了ロットも入れる。履歴なので外さない)
 * @param {number} [args.minSamples=5] 人×工程の組をこの件数から使う
 * @param {number[]} [args.clamp=[0.5,2.0]] 係数の下限・上限(倍)
 * @param {number} [args.minStepsForWorker=2] 「人ぜんぶ」の係数を出すのに要る工程の数
 * @param {string[]} [args.acceptStatuses=['completed']]
 * @param {string[]} [args.acceptedQuality] 既定は estimate.js の ACCEPTED_QUALITY(確定+推定)
 * @returns {{
 *   byWorkerStep: object, byWorker: object, warnings: string[], diagnostics: object,
 *   minSamples: number, clamp: number[]
 * }}
 *   byWorkerStep … 鍵は workerStepKeyOf(名前, 工程キー)
 *     { worker, stepKey, title, n, stepN, otherN, share,
 *       workerMedianSec, stepMedianSec, othersMedianSec,
 *       raw, rawVsOthers, ratio, clamped, enough, why }
 *     ratio … 使ってよい係数。件数が足りない組は null(1.0 で埋めない)
 *   byWorker … 鍵は名前 { worker, steps, n, raw, ratio, clamped, enough, why }
 */
export function buildWorkerSpeed({
  lots,
  minSamples = MIN_SAMPLE_FOR_HIGH,
  clamp = [0.5, 2.0],
  minStepsForWorker = 2,
  acceptStatuses = ['completed'],
  acceptedQuality = ACCEPTED_QUALITY,
} = {}) {
  const warnings = [];
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');
  const okQ = new Set(asArray(acceptedQuality).map((v) => str(v).trim()).filter(Boolean));
  if (okQ.size === 0) ACCEPTED_QUALITY.forEach((q) => okQ.add(q));
  const minN = Number.isInteger(Number(minSamples)) && Number(minSamples) >= 1 ? Number(minSamples) : MIN_SAMPLE_FOR_HIGH;
  const minSteps = Number.isInteger(Number(minStepsForWorker)) && Number(minStepsForWorker) >= 1 ? Number(minStepsForWorker) : 2;

  const diagnostics = {
    lotsSeen: 0, tasksSeen: 0,
    droppedStatus: 0, droppedStep: 0, droppedDuration: 0,
    droppedQuality: 0, droppedTrainee: 0, droppedHandoff: 0, droppedNoWorker: 0,
    used: 0,
  };

  const list = asArray(lots);
  if (list.length === 0) {
    warnings.push('ロットが1件も渡されていません。人ごとの速さは何も出しません。');
    return { byWorkerStep: {}, byWorker: {}, warnings, diagnostics, minSamples: minN, clamp: asArray(clamp).slice(0, 2) };
  }

  /** 工程キー -> 秒の配列(全員ぶん) */
  const byStep = new Map();
  /** 人×工程の鍵 -> { worker, stepKey, title, secs[] } */
  const byWS = new Map();
  /** 工程キー -> 題(画面に出す用) */
  const titleOf = new Map();

  for (const lot of list) {
    if (!isObj(lot)) continue;
    diagnostics.lotsSeen += 1;
    const steps = asArray(lot.steps);
    const templateId = str(lot.templateId);
    const tasks = isObj(lot.tasks) ? lot.tasks : {};
    for (const [taskKey, task] of Object.entries(tasks)) {
      if (!isObj(task)) continue;
      diagnostics.tasksSeen += 1;
      if (!ok.has(str(task.status))) { diagnostics.droppedStatus += 1; continue; }
      // 🎓 教育中の記録は速さの物差しから外す(実費からは外さない)。
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
      const worker = [...names][0];

      const stepKey = processKeyOf(templateId, str(r.stepId));
      if (!titleOf.has(stepKey)) titleOf.set(stepKey, str(r.step && r.step.title));
      let all = byStep.get(stepKey);
      if (!all) { all = []; byStep.set(stepKey, all); }
      all.push(sec);

      const k = workerStepKeyOf(worker, stepKey);
      let e = byWS.get(k);
      if (!e) { e = { worker, stepKey, secs: [] }; byWS.set(k, e); }
      e.secs.push(sec);
      diagnostics.used += 1;
    }
  }

  if (diagnostics.droppedTrainee > 0) {
    warnings.push(`教育中として記録された作業 ${diagnostics.droppedTrainee}件を、速さの物差しから外しました（かかった時間そのものからは外していません）。`);
  }
  if (diagnostics.droppedHandoff > 0) {
    warnings.push(`1件の作業を2人以上で分けた記録 ${diagnostics.droppedHandoff}件は、誰の速さか決められないので外しました。`);
  }
  if (diagnostics.droppedNoWorker > 0) {
    warnings.push(`やった人の名前が入っていない記録 ${diagnostics.droppedNoWorker}件を外しました。`);
  }
  if (diagnostics.used === 0) {
    warnings.push('速さを数えられる記録が1件もありませんでした。');
  }

  // 工程ごとに「その工程をやった人の組」を並べておく。
  // ⚠ ここでまとめておかないと、組の数の2乗ぶん数え直す事になる(工程が増えるほど遅くなる)。
  const groupsOfStep = new Map();
  for (const [, e] of byWS) {
    let a = groupsOfStep.get(e.stepKey);
    if (!a) { a = []; groupsOfStep.set(e.stepKey, a); }
    a.push(e);
  }

  // ── 人×工程 ────────────────────────────────────────────────────────────
  const byWorkerStep = {};
  const perWorkerRatios = new Map();   // 名前 -> [{ raw, n }]
  for (const [k, e] of byWS) {
    const all = byStep.get(e.stepKey) || [];
    const stepN = all.length;
    const n = e.secs.length;
    const otherN = stepN - n;
    const workerMedianSec = medianSec(e.secs);
    const stepMedianSec = medianSec(all);
    // その人**以外**の中央値。⚠ 1人しかやっていない工程で「みんなの真ん中」を名乗らせない。
    const others = [];
    for (const o of (groupsOfStep.get(e.stepKey) || [])) {
      if (o.worker === e.worker) continue;
      for (const s of o.secs) others.push(s);
    }
    const othersMedianSec = medianSec(others);
    const raw = (Number.isFinite(stepMedianSec) && stepMedianSec > 0 && Number.isFinite(workerMedianSec))
      ? workerMedianSec / stepMedianSec : null;
    const rawVsOthers = (Number.isFinite(othersMedianSec) && othersMedianSec > 0 && Number.isFinite(workerMedianSec))
      ? workerMedianSec / othersMedianSec : null;
    // 🚨 使ってよい条件は2つ。
    //   ・その人の件数が minSamples 以上
    //   ・**その人以外**の件数も minSamples 以上(比べる相手が居ないと、比は必ず 1.0 になる)
    const enough = n >= minN && otherN >= minN && raw != null;
    const c = enough ? clampRatio(raw, clamp) : { ratio: null, clamped: false };
    const share = stepN > 0 ? n / stepN : 0;
    byWorkerStep[k] = {
      worker: e.worker,
      stepKey: e.stepKey,
      title: titleOf.get(e.stepKey) || '',
      n, stepN, otherN, share,
      workerMedianSec, stepMedianSec, othersMedianSec,
      raw, rawVsOthers,
      ratio: c.ratio, clamped: c.clamped,
      enough,
      why: enough
        ? `この人 ${n}件の真ん中 ${Math.round(workerMedianSec)}秒 ÷ この工程 ${stepN}件の真ん中 ${Math.round(stepMedianSec)}秒 = ${raw.toFixed(2)}倍`
          + (c.clamped ? `（${clampLabel(clamp)} に収めました）` : '')
        : (n < minN
          ? `この人の記録が ${n}件です（${minN}件から使います）`
          : `比べる相手の記録が ${otherN}件です（${minN}件から使います）`),
    };
    if (enough && c.ratio != null) {
      let arr = perWorkerRatios.get(e.worker);
      if (!arr) { arr = []; perWorkerRatios.set(e.worker, arr); }
      arr.push({ raw, n });
    }
  }

  // ── 人ぜんぶ ───────────────────────────────────────────────────────────
  // 🚨 「その人の全記録の中央値 ÷ 全体の中央値」では作らない。
  //    長い工程ばかりやっている人が、それだけで遅い事になってしまう。
  //    工程ごとの倍率を出してから、その真ん中を取る(工程の混ざり方に左右されない)。
  const byWorker = {};
  for (const [worker, arr] of perWorkerRatios) {
    const raws = arr.map((x) => x.raw);
    const nSum = arr.reduce((a, x) => a + x.n, 0);
    const med = medianSec(raws);
    const enough = arr.length >= minSteps && med != null;
    const c = enough ? clampRatio(med, clamp) : { ratio: null, clamped: false };
    byWorker[worker] = {
      worker,
      steps: arr.length,
      n: nSum,
      raw: med,
      ratio: c.ratio,
      clamped: c.clamped,
      enough,
      why: enough
        ? `${arr.length}工程・${nSum}件の記録から、工程ごとの倍率の真ん中が ${med.toFixed(2)}倍`
          + (c.clamped ? `（${clampLabel(clamp)} に収めました）` : '')
        : `倍率を出せた工程が ${arr.length}工程です（${minSteps}工程から使います）`,
    };
  }

  return { byWorkerStep, byWorker, warnings, diagnostics, minSamples: minN, clamp: asArray(clamp).slice(0, 2) };
}

/** 「0.5〜2.0倍」の言い方。⚠ clamp の指定が読めない時は空文字(数字を作らない)。 */
export const clampLabel = (clamp) => {
  const lo = Number(Array.isArray(clamp) ? clamp[0] : NaN);
  const hi = Number(Array.isArray(clamp) ? clamp[1] : NaN);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  return `${lo}〜${hi}倍`;
};

// -----------------------------------------------------------------------------
//  2. 割付で使う(1件ぶんの時間へ掛ける)
// -----------------------------------------------------------------------------
/** 掛け方。⚠ 既定は off。渡さなければ時間は 1バイトも変わらない。 */
export const SPEED_MODE = Object.freeze({
  /** 切ってある(全員が同じ目標時間) */
  OFF: 'off',
  /**
   * 人×工程が在ればそれ。無ければ **その人ぜんぶへ落ちる**。どちらも無ければ掛けない。
   * 🚨 落ちた事は黙らせない。戻りの fellBack が true になり、why にも書く。
   *   本番の写しでは この落ち方が 80.0%(下の実測)。「残りは目標時間のまま」ではない。
   */
  WORKER_STEP: 'workerStep',
  /**
   * 人×工程が在る時 **だけ** 掛ける。無ければ 目標時間のまま(人ぜんぶへ落ちない)。
   * 「工程ごとの差だけを見たい」時はこちら。落ちない事を呼ぶ側が選べるように在る。
   */
  WORKER_STEP_ONLY: 'workerStepOnly',
  /** その人ぜんぶだけ。工程ごとの差は見ない */
  WORKER: 'worker',
});

/**
 * 目標時間へ「人ごとの速さ」を掛ける。
 *
 * 🚨 mode を渡さなければ何もしない(既定 off)。
 * 🚨 数字を作らない: 係数が無い組は baseSec をそのまま返し、applied:false と理由を返す。
 * 🚨🚨 **黙って落ちない**(2026-09-10 の指摘)。
 *   mode:'workerStep' で人×工程の記録が足りない時は、その人ぜんぶの倍率へ落ちる。
 *   落ちた事は `fellBack:true` と why の言葉で必ず言う。落ちてほしくない呼ぶ側は
 *   mode:'workerStepOnly' を渡す(その時は目標時間のまま returns source:'none')。
 *   ⚠ 落ち先は「その人ぜんぶ」= 工程の差を見ていない倍率。本番の写しでは 村さん 0.75倍 で、
 *     記録の無い工程まで一律 25%短くなる。だから黙らせてはいけない。
 *
 * @param {number} baseSec その工程 1回ぶんの時間(秒)
 * @param {object} args
 * @param {string} args.worker 人の名前(割付が選んだ人)
 * @param {string} args.stepKey processKeyOf(templateId, stepId)。job.processKey と同じ物
 * @param {object} args.speed buildWorkerSpeed の戻り
 * @param {string} [args.mode='off']
 * @returns {{ sec:number|null, applied:boolean, why:string, ratio:number|null, n:number,
 *             source:string, fellBack:boolean, stepN:number }}
 *   source  … 'off' | 'workerStep' | 'worker' | 'none'
 *   fellBack… 人×工程を頼んだのに その人ぜんぶの倍率で答えた時だけ true
 *   stepN   … 人×工程の記録の件数(足りなくても数は出す。0 は「その組の記録が1件も無い」)
 */
export function applyWorkerSpeed(baseSec, { worker, stepKey, speed, mode = SPEED_MODE.OFF } = {}) {
  const base = Number(baseSec);
  if (!Number.isFinite(base) || base <= 0) {
    return { sec: null, applied: false, why: '元の時間が入っていません（人ごとの速さは掛けません）', ratio: null, n: 0, source: 'none', fellBack: false, stepN: 0 };
  }
  const m = str(mode);
  const wantsStep = (m === SPEED_MODE.WORKER_STEP || m === SPEED_MODE.WORKER_STEP_ONLY);
  if (!wantsStep && m !== SPEED_MODE.WORKER) {
    return { sec: base, applied: false, why: '人ごとの速さは切ってあります（全員が同じ目標時間）', ratio: null, n: 0, source: 'off', fellBack: false, stepN: 0 };
  }
  const w = trimmed(worker);
  if (!w) {
    return { sec: base, applied: false, why: '誰がやるか決まっていません', ratio: null, n: 0, source: 'none', fellBack: false, stepN: 0 };
  }
  const byWorkerStep = (speed && isObj(speed.byWorkerStep)) ? speed.byWorkerStep : {};
  const byWorker = (speed && isObj(speed.byWorker)) ? speed.byWorker : {};

  // 人×工程。⚠ 足りない時も件数(stepN)は持って回る。「0件」と「4件」を同じ顔にしない。
  const e = wantsStep ? byWorkerStep[workerStepKeyOf(w, str(stepKey))] : null;
  const stepN = (e && Number.isFinite(e.n)) ? e.n : 0;
  if (e && e.enough && Number.isFinite(e.ratio) && e.ratio > 0) {
    return {
      sec: Math.max(1, Math.round(base * e.ratio)),
      applied: true,
      why: `${w}さんのこの工程 ${e.n}件の記録から ${e.ratio.toFixed(2)}倍`,
      ratio: e.ratio, n: e.n, source: 'workerStep', fellBack: false, stepN,
    };
  }
  // 🚨 落ちない、と頼まれている時はここで止める(黙って人ぜんぶの倍率を掛けない)。
  if (m === SPEED_MODE.WORKER_STEP_ONLY) {
    return {
      sec: base,
      applied: false,
      why: `${w}さんのこの工程の記録が ${stepN}件です（工程ごとの記録だけで掛ける約束なので、目標時間のままです）`,
      ratio: null, n: 0, source: 'none', fellBack: false, stepN,
    };
  }

  const g = byWorker[w];
  if (g && g.enough && Number.isFinite(g.ratio) && g.ratio > 0) {
    const fellBack = wantsStep;
    return {
      sec: Math.max(1, Math.round(base * g.ratio)),
      applied: true,
      why: fellBack
        // 🚨 落ちた事を1行目に書く。「この工程の記録から」と読み違えられない言い方にする。
        ? `${w}さんのこの工程の記録は ${stepN}件で足りないので、`
          + `**この工程ではなく ${w}さんぜんぶ** の ${g.steps}工程・${g.n}件から ${g.ratio.toFixed(2)}倍`
        : `${w}さんの ${g.steps}工程・${g.n}件の記録から ${g.ratio.toFixed(2)}倍`,
      ratio: g.ratio, n: g.n, source: 'worker', fellBack, stepN,
    };
  }
  return {
    sec: base,
    applied: false,
    why: `${w}さんのこの工程の記録が足りません（目標時間のまま）`,
    ratio: null, n: 0, source: 'none', fellBack: false, stepN,
  };
}

/**
 * 「この掛け方だと、どれだけが人×工程で、どれだけが その人ぜんぶへ落ちるか」を数える。
 *
 * 🚨 画面へ「人ごとの速さを入れます」と出す前に、必ずこれを見せる事。
 *   本番の写しでは 80% が落ちる(= 工程の差ではなく、その人の一律の倍率が効く)。
 *   数えずに入れると「工程ごとに測った速さで動きます」と言いながら、
 *   実際には 村さん一律 0.75倍 の盤を出す事になる。
 *
 * ⚠ ここで割付をやり直さない。渡された「工程キー × 人」の組を素通しで数えるだけ。
 * @param {{stepKey:string}[]} pairs 数える組。{ stepKey } と { worker } を持つ物
 * @param {object} args speed / mode は applyWorkerSpeed と同じ物
 * @returns {{ total:number, workerStep:number, worker:number, none:number, off:number, fellBack:number }}
 */
export const workerSpeedSourceCounts = (pairs, { speed, mode = SPEED_MODE.OFF } = {}) => {
  const out = { total: 0, workerStep: 0, worker: 0, none: 0, off: 0, fellBack: 0 };
  for (const p of asArray(pairs)) {
    if (!isObj(p)) continue;
    const r = applyWorkerSpeed(600, { worker: p.worker, stepKey: p.stepKey, speed, mode });
    out.total += 1;
    if (out[r.source] !== undefined) out[r.source] += 1;
    if (r.fellBack) out.fellBack += 1;
  }
  return out;
};

/** 画面に出す1行(人×工程)。⚠ 数字はここまでで数えた物だけ。手書きしない。 */
export const workerSpeedRows = (speed) => {
  const src = (speed && isObj(speed.byWorkerStep)) ? speed.byWorkerStep : {};
  return Object.values(src)
    .map((e) => ({
      worker: e.worker,
      stepKey: e.stepKey,
      title: e.title,
      n: e.n,
      ratio: e.ratio,
      enough: e.enough,
      clamped: e.clamped,
      note: e.enough
        ? `${e.worker}さん ${e.n}件・この工程ぜんぶ ${e.stepN}件。${e.ratio > 1 ? `真ん中より ${((e.ratio - 1) * 100).toFixed(0)}% 長い` : e.ratio < 1 ? `真ん中より ${((1 - e.ratio) * 100).toFixed(0)}% 短い` : '真ん中と同じ'}`
        : e.why,
    }))
    .sort((a, b) => (b.n - a.n) || String(a.worker).localeCompare(String(b.worker), 'ja'));
};

export default buildWorkerSpeed;
