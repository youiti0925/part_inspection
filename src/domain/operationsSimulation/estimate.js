// =============================================================================
//  estimate.js — 工程1回あたりの所要時間を「確定実績から」見積もる(仕様書5.6 / F1)
// -----------------------------------------------------------------------------
//  🚨 ここが守る事:
//    ① **測っていない物に数字を作らない**。分からなければ seconds:null。
//       60秒・0秒・平均などで埋めない(仕様書 T030)。0 を入れると
//       「この工程は時間がかからない」と読めてしまい、本物の0秒と区別が付かないまま
//       合計へ足されて「人手が足りている」という嘘になる。
//    ② **どこから来た数字か・標本が何件か・どれくらい信じてよいかを必ず一緒に返す**。
//       数字だけを返すと、目標時間(測っていない値)と実績(測った値)が画面で同じ顔をする。
//    ③ **固定の 38/64/81% みたいな線で代用しない**(仕様書5.6)。
//       実績が足りない対象は「テンプレート目標」または「不明」とはっきり書く。
//
//  ⚠ ここは純関数だけ。Firestore も React も localStorage も触らない
//    (node --test だけで全部確かめられるようにするため)。
//
// -----------------------------------------------------------------------------
//  実データで測った事(2026-08-23 本番 製品検査 636ロット / inspection-audit-local)
// -----------------------------------------------------------------------------
//    完了タスク 5,974件 → 工程が決まった物 5,945件 → 所要時間>0 が 5,931件
//      (うち 199件は「やり直し(reworks)」の時間を含む。task.duration には入らないので
//       足さないと消える。実測で 209件/32.13h が漏れていた事がある → dailyWork.js:57)
//    工程キー(templateId+stepId) 184本のうち
//      n>=5 が 103本(56.0%) / n>=10 が 93本 / n>=30 が 45本
//    実績P75 ÷ テンプレート目標 = 中央 0.90倍(遅い44工程 / 速い58工程)
//      ⚠ つまり目標時間は「だいたい合っているが、工程ごとに 0.07〜5.42倍 ばらつく」。
//        目標をそのまま実績の代わりに使うと、工程によっては桁が違う。
// =============================================================================

// 🚨 工程の当て方は soloDependency.js の物を **そのまま** 使う。
//    自前で当て直すと集計とキーがズレて、別工程の時間を掴む(processTimes.js と同じ約束)。
import { resolveTaskProcess, processKeyOf } from '../soloDependency.js';
// 🚨 「台ごと / ロットに1回」の判定も既存の物を使う。ここで作り直さない。
import { isOncePerLotStep } from '../finishEta.js';
// 🚨 実績の質。仕様書6.5「低信頼・記録不足を標本に混ぜない」。既存の判定をそのまま使う。
import { taskTimeQualityOf } from '../taskTimeQuality.js';

// -----------------------------------------------------------------------------
// 0. 語彙
// -----------------------------------------------------------------------------
/** 見積りの出どころ。**採用順そのもの**(仕様書5.6)。 */
export const ESTIMATE_SOURCE = Object.freeze({
  /** ① 管理者が承認した補正値(型式別の較正値)。人が決めた値。 */
  CALIBRATED: 'calibrated',
  /** ② 同一型式・同一テンプレート・同一工程の実績。標本5件以上の時だけ。 */
  MODEL_STEP: 'model-step',
  /**
   * ③ 同一工程群の実績。標本5件以上の時だけ。
   * ⚠ 群は2段ある(groupLevel で区別する)。仕様書の source は5値のままにしたいので
   *   どちらも 'step-group' で返し、**どの群から来たか**は groupLevel に入れる。
   */
  STEP_GROUP: 'step-group',
  /** ④ テンプレートの目標時間。**測った値ではない**。 */
  TEMPLATE_TARGET: 'template-target',
  /** ⑤ 分からない。**数字を作らない**。 */
  MISSING: 'missing',
});

/** 見積りモード。通常線=P50 / 保険線=P75 / 絶対線=P90(仕様書5.6)。 */
export const ESTIMATE_MODE = Object.freeze({ P50: 'P50', P75: 'P75', P90: 'P90' });
export const DEFAULT_ESTIMATE_MODE = ESTIMATE_MODE.P75;
const MODE_P = Object.freeze({ P50: 0.5, P75: 0.75, P90: 0.9 });

/**
 * 「高信頼」と言ってよい最低標本数(仕様書 T029)。
 * ⚠ここを下げると、1〜2件の実績で「確かな見積り」と言い切る事になる。
 */
export const MIN_SAMPLE_FOR_HIGH = 5;

const str = (v) => (v == null ? '' : String(v));
const normTitle = (v) => str(v).replace(/\s+/g, '').trim();
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/** 実績を「使ってよい」と判断する記録の質(仕様書6.5)。 */
export const ACCEPTED_QUALITY = Object.freeze(['confirmed', 'estimated']);

/**
 * 🚨 鍵の組み方と質の絞り方(2026-08-23 本番実データで決めた。憶測ではない)
 * -----------------------------------------------------------------------------
 * 【なぜ型式を鍵に入れるか】
 *   soloDependency.processKeyOf は `templateId + stepId` だけで、**型式が入っていない**。
 *   本番で測ると 28テンプレのうち **19が複数型式を載せている**(最大65型式が1テンプレ)。
 *   ロットの **93.6%(595/636)** がそのテンプレに乗る。
 *   だから processKeyOf だけで「同一型式の実績」と言うと嘘になる(仕様書5.6 の2位が成立しない)。
 *
 * 【工程群を2段にした理由】(未完了ロットで見積りたい工程 1,017種 に対する到達率・実測)
 *   ② 型式+テンプレ+工程   n>=5 で引ける …  13.5%
 *   ③ テンプレ+工程(型式横断) …………………  69.0%   ← ここが本体
 *   ④ 題+台ごと(全テンプレ) …………………  13.5%
 *   実績で引けない ……………………………………   4.0%  → 目標時間か「分かりません」
 *   1段だけだと、型式まで合わせると 13.5% しか埋まらず、題だけだと別工程を混ぜる。
 *
 * 【質の絞り方】taskTimeQuality.js の判定で **低信頼(unreliable)と記録不足(missing)を捨てる**。
 *   実測 5,931件 = 確定1,204 / 推定3,452 / 低信頼670 / 記録不足605。
 *   ⚠ 仕様書6.5 は「確定実績だけ」と読めるが、**確定だけにすると②の到達率が 3.9% まで落ちる**
 *     (テンプレ+工程でも 70.2%)。現場の打刻(sessions)がまだ2割にしか入っていないため。
 *   → 当面は 確定+推定 を使い、**どの質が何件混ざったかを qualityMix で必ず一緒に返す**。
 *     確定だけに絞りたくなったら acceptedQuality を渡せば切り替わる。
 *
 * 🚨 分位点の定義がアプリ内で2つある事に注意:
 *   ここ(estimate.js)      … 線形補間(Excel の PERCENTILE.INC と同じ)
 *   arrivalActual.js:72    … 上位側へ丸める(補間しない)
 *   実測の差: n=5 の P90 が 46 と 50。n=10 の P75 が 7.75 と 8。
 *   到着分析と工数見積りは別の話なのでそのままにしてあるが、**同じ数字だと思ってはいけない**。
 */

/** ② 同一型式・同一テンプレート・同一工程。 */
export const modelStepKeyOf = (model, templateId, stepId) => {
  const m = str(model);
  const t = str(templateId);
  return `${m.length}:${m}:${t.length}:${t}:${str(stepId)}`;
};

/** ③ 工程群A = 同じテンプレートの同じ工程(型式は問わない)。 */
export const templateStepKeyOf = (templateId, stepId) => processKeyOf(templateId, stepId);

/**
 * ④ 工程群B = 同じ題・同じ扱い(台ごと/ロット1回)。テンプレートをまたぐ。
 * ⚠ 区切り文字を入れないと「題A+unit」と「題Au+nit」が同じ鍵になる。
 * ⚠ 製品検査の step.category は **184工程すべて空**(分類は最終検査の概念)なので
 *   分類は鍵に入れない(入れても全部同じ値で意味が無い)。
 */
export const stepGroupKeyOf = (step) => {
  const title = normTitle(step && step.title);
  const perUnit = !isOncePerLotStep(step || {});
  return `${title}${perUnit ? 'unit' : 'lot'}`;
};

// -----------------------------------------------------------------------------
// 1. 分位点
// -----------------------------------------------------------------------------
/**
 * 分位点。**線形補間**(Excel の PERCENTILE.INC / R の type 7 と同じ)。
 *
 * 🚨 なぜ「決め方を1つに固定する」と書くか:
 *   分位点の定義は9種類ある。上位側に丸める(nearest-rank)方式と線形補間では、
 *   標本5件の P75 が **別の値** になる。同じデータで数字が変わると
 *   「昨日と違う」が説明できなくなる。だからここに1つだけ書いて、他所で計算しない。
 *
 * @param {number[]} values 昇順でなくてよい(中で写して並べ替える。引数は書き換えない)
 * @param {number} p 0〜1
 * @returns {number|null} 標本0件なら null(0 を返さない)
 */
export function percentile(values, p) {
  const a = asArray(values).map(Number).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (a.length === 0) return null;
  const pp = Number.isFinite(Number(p)) ? Math.min(1, Math.max(0, Number(p))) : 0.5;
  if (a.length === 1) return a[0];
  const i = (a.length - 1) * pp;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  if (lo === hi) return a[lo];
  return a[lo] + (a[hi] - a[lo]) * (i - lo);
}

// -----------------------------------------------------------------------------
// 2. 確定実績を集める
// -----------------------------------------------------------------------------
/**
 * 1つの完了タスクの所要秒。
 * 🚨 **やり直し(reworks)の時間を足す**。task.duration には入らない仕様なので、
 *    足さないと「やり直した分」が丸ごと消える(dailyWork.js:57 の注記・実測209件/32.13h)。
 * @returns {number|null} 0以下・読めない物は null(0 を標本に入れない)
 */
export function taskDurationSec(task) {
  if (!isObj(task)) return null;
  const base = Number(task.duration);
  const rework = asArray(task.reworks).reduce((a, r) => {
    const d = Number(r && r.duration);
    return a + (Number.isFinite(d) && d > 0 ? d : 0);
  }, 0);
  const sec = (Number.isFinite(base) && base > 0 ? base : 0) + rework;
  return sec > 0 ? sec : null;
}

/**
 * 全ロットの完了タスクから、工程ごと・工程群ごとの所要秒の**生の配列**を作る。
 *
 * ⚠ 生の配列を持つ理由: 分位点は平均や中央値からは作れない。
 *   processTimes.js は「いつやったか」しか返さないので、ここで別に集める。
 *
 * ⚠ 数える対象は computeSoloDependency / computeProcessTimes と**同じ条件**にそろえる
 *   (status が accept、工程が決まったタスク)。ズラすと件数が突き合わなくなる。
 *
 * 🚨 外れ値を**黙って捨てない**。分位点(P50/P75/P90)自体が外れ値に強い。
 *   捨てると「実際に4.6倍かかった日がある」という事実が消える。
 *   捨てたい時は呼ぶ側が maxSec を渡し、diagnostics.dropped で何件落ちたか見える様にする。
 *
 * @param {object} args
 * @param {Array} args.lots 全ロット(**完了ロットも含める**。履歴なので対象外にしない)
 * @param {string[]} [args.acceptStatuses] 既定 ['completed']
 * @param {number|null} [args.maxSec] これを超える標本を落とす。既定 null(落とさない)
 * @returns {{byProcessKey:Map<string,object>, byGroup:Map<string,object>, diagnostics:object}}
 */
export function buildDurationStats({
  lots,
  acceptStatuses = ['completed'],
  acceptedQuality = ACCEPTED_QUALITY,
  maxSec = null,
} = {}) {
  // ⚠ 空白だけの値は「指定なし」と同じ。trim せずに filter(Boolean) だけだと
  //   '  ' が生き残り、既定('completed')へ逃げないまま **1件も数えない** 束ができる。
  //   件数が0なので画面には何の警告も出ず、黙って「実績ゼロ」になる。
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');
  const okQ = new Set(asArray(acceptedQuality).map((v) => str(v).trim()).filter(Boolean));
  if (okQ.size === 0) ACCEPTED_QUALITY.forEach((q) => okQ.add(q));
  const cap = Number.isFinite(Number(maxSec)) && Number(maxSec) > 0 ? Number(maxSec) : null;

  const byModelStep = new Map();
  const byTemplateStep = new Map();
  const byTitleGroup = new Map();
  const diagnostics = {
    lotsSeen: 0,
    tasksSeen: 0,
    tasksAccepted: 0,
    tasksResolved: 0,
    tasksWithDuration: 0,
    tasksWithoutDuration: 0,
    tasksWithRework: 0,
    /** 🚨 質で捨てた件数。理由ごとに数える(黙って捨てない) */
    droppedByQuality: 0,
    droppedQualityMix: {},
    dropped: 0,
    /** 採った標本の質の内訳 */
    qualityMix: {},
  };

  const push = (map, key, meta, sec, quality) => {
    let e = map.get(key);
    if (!e) {
      e = { key, samples: [], qualityMix: {}, ...meta };
      map.set(key, e);
    }
    e.samples.push(sec);
    e.qualityMix[quality] = (e.qualityMix[quality] || 0) + 1;
  };

  asArray(lots).forEach((lot) => {
    if (!isObj(lot)) return;
    diagnostics.lotsSeen += 1;
    const steps = asArray(lot.steps);
    const templateId = str(lot.templateId);
    const model = str(lot.model);
    const tasks = isObj(lot.tasks) ? lot.tasks : {};
    Object.entries(tasks).forEach(([taskKey, task]) => {
      if (!isObj(task)) return;
      diagnostics.tasksSeen += 1;
      if (!ok.has(str(task.status))) return;
      diagnostics.tasksAccepted += 1;
      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) return;
      diagnostics.tasksResolved += 1;
      const sec = taskDurationSec(task);
      if (sec == null) {
        diagnostics.tasksWithoutDuration += 1;
        return;
      }
      if (asArray(task.reworks).some((x) => Number(x && x.duration) > 0)) diagnostics.tasksWithRework += 1;

      // 🚨 記録の質。低信頼・記録不足を標本に入れない(仕様書6.5)。
      const quality = str((taskTimeQualityOf(task) || {}).quality) || 'missing';
      if (!okQ.has(quality)) {
        diagnostics.droppedByQuality += 1;
        diagnostics.droppedQualityMix[quality] = (diagnostics.droppedQualityMix[quality] || 0) + 1;
        return;
      }
      if (cap != null && sec > cap) {
        diagnostics.dropped += 1;
        return;
      }
      diagnostics.tasksWithDuration += 1;
      diagnostics.qualityMix[quality] = (diagnostics.qualityMix[quality] || 0) + 1;

      const step = r.step || {};
      const perUnit = !isOncePerLotStep(step);
      const sid = str(r.stepId);
      push(byModelStep, modelStepKeyOf(model, templateId, sid),
        { model, templateId, stepId: sid, title: str(step.title), perUnit }, sec, quality);
      push(byTemplateStep, templateStepKeyOf(templateId, sid),
        { templateId, stepId: sid, title: str(step.title), perUnit }, sec, quality);
      push(byTitleGroup, stepGroupKeyOf(step),
        { title: normTitle(step.title), perUnit }, sec, quality);
    });
  });

  // 分位点を先に計算して持たせる(1工程を何度も引くので、毎回並べ替えない)
  for (const map of [byModelStep, byTemplateStep, byTitleGroup]) {
    for (const e of map.values()) {
      e.n = e.samples.length;
      e.p50 = percentile(e.samples, 0.5);
      e.p75 = percentile(e.samples, 0.75);
      e.p90 = percentile(e.samples, 0.9);
    }
  }
  return { byModelStep, byTemplateStep, byTitleGroup, diagnostics };
}

/** 統計の1件から、モードに応じた秒を取り出す。 */
const pickByMode = (entry, mode) => {
  if (!entry) return null;
  if (mode === ESTIMATE_MODE.P50) return entry.p50;
  if (mode === ESTIMATE_MODE.P90) return entry.p90;
  return entry.p75;
};

// -----------------------------------------------------------------------------
// 3. 較正値(管理者が入れた値)
// -----------------------------------------------------------------------------
/**
 * 🚨 App.jsx の getEffectiveTargetTime と **同じ順**(normalizeInput.js の estimateOf から移設)。
 *   ① 型式別の較正値 customTargetTimes[`model_${型式}`][`${分類}_${題}`]
 *   ② 同じ型式グループの別型式の較正値
 *   順を変えると、画面に出ている目標時間とシミュレーターの見積が食い違う。
 */
export const targetTimeStepKey = (step) => `${str(step && step.category)}_${str(step && step.title)}`;

const calibratedSec = (step, model, customTargetTimes, modelGroups) => {
  if (!model || !isObj(customTargetTimes)) return null;
  const sk = targetTimeStepKey(step);
  const own = customTargetTimes[`model_${model}`] && customTargetTimes[`model_${model}`][sk];
  if (typeof own === 'number' && own > 0) return own;
  const g = asArray(modelGroups).find((gr) => Array.isArray(gr && gr.models) && gr.models.includes(model));
  if (g) {
    for (const sibling of g.models) {
      if (sibling === model) continue;
      const v = customTargetTimes[`model_${sibling}`] && customTargetTimes[`model_${sibling}`][sk];
      if (typeof v === 'number' && v > 0) return v;
    }
  }
  return null;
};

// -----------------------------------------------------------------------------
// 4. 見積り本体
// -----------------------------------------------------------------------------
/**
 * @typedef {object} DurationEstimate
 * @property {number|null} seconds 見積り秒。**分からなければ null**(0 でも 60 でもない)
 * @property {'P50'|'P75'|'P90'} mode 要求されたモード。実績以外の出どころでも記録する
 * @property {'calibrated'|'model-step'|'step-group'|'template-target'|'missing'} source 出どころ
 * @property {number} sampleCount 採用した実績の件数。実績以外は 0
 * @property {'high'|'medium'|'low'|'unknown'} confidence 信頼度
 * @property {string} why 画面にそのまま出せる日本語の理由
 */

/**
 * 採用順(仕様書5.6):
 *   ① 管理者が承認した補正値                    → high
 *   ② 同一型式・同一テンプレート・同一工程の実績 n>=5 → high
 *   ③ 同一工程群の実績                          n>=5 → medium(群内が中央1.42倍ずれるので high と言わない)
 *   ④ テンプレート目標時間                      → low(測った値ではない)
 *   ⑤ 不明                                      → unknown / seconds:null
 *
 * 🚨 n<5 の実績を「高信頼」として使わない(T029)。**そもそも採らない**で次の段へ落とす。
 *    ただし件数は why に残す(何件しか無いのかを画面で言えるように)。
 */
export function estimateDuration({
  step,
  templateId = null,
  model = null,
  customTargetTimes = null,
  modelGroups = null,
  stats = null,
  mode = DEFAULT_ESTIMATE_MODE,
  minSample = MIN_SAMPLE_FOR_HIGH,
} = {}) {
  const m = MODE_P[mode] === undefined ? DEFAULT_ESTIMATE_MODE : mode;
  const need = Number.isFinite(Number(minSample)) && Number(minSample) > 0
    ? Number(minSample) : MIN_SAMPLE_FOR_HIGH;
  const out = (seconds, source, sampleCount, confidence, why, extra = {}) => ({
    seconds, mode: m, source, sampleCount, confidence, why,
    groupLevel: null, qualityMix: null, ...extra,
  });

  // ① 較正値(管理者が入れた値)
  const cal = calibratedSec(step, model, customTargetTimes, modelGroups);
  if (cal != null) return out(cal, ESTIMATE_SOURCE.CALIBRATED, 0, 'high', '管理者が入れた補正値');

  const sid = str(step && (step.id != null ? step.id : step.stepId));
  const notes = [];
  /** 段を1つ試す。n が足りなければ理由を控えて次へ落とす。 */
  const tryTier = (map, key, label) => {
    if (!(map instanceof Map) || !key) return null;
    const e = map.get(key);
    if (!e) return null;
    if (e.n < need) {
      notes.push(`${label}の実績は${e.n}件(${need}件必要)`);
      return null;
    }
    const sec = pickByMode(e, m);
    if (sec == null || !(sec > 0)) return null;
    return { e, sec };
  };

  if (stats && step) {
    // ② 同一型式・同一テンプレート・同一工程 → high
    const t2 = tryTier(stats.byModelStep, modelStepKeyOf(str(model), str(templateId), sid), 'この型式・この工程');
    if (t2) {
      return out(t2.sec, ESTIMATE_SOURCE.MODEL_STEP, t2.e.n, 'high',
        `この型式・この工程の実績 ${t2.e.n}件の${m}`,
        { groupLevel: 'model-step', qualityMix: t2.e.qualityMix });
    }
    // ③ 工程群A: 同じテンプレートの同じ工程(型式は問わない) → medium
    const t3 = tryTier(stats.byTemplateStep, templateStepKeyOf(str(templateId), sid), '同じ手順書のこの工程');
    if (t3) {
      return out(t3.sec, ESTIMATE_SOURCE.STEP_GROUP, t3.e.n, 'medium',
        `${notes.length ? notes.join('・') + '。' : ''}同じ手順書の同じ工程の実績 ${t3.e.n}件の${m}(「型式は違う物も混ざる」)`,
        { groupLevel: 'template-step', qualityMix: t3.e.qualityMix });
    }
    // ④ 工程群B: 同じ題・同じ扱い(手順書をまたぐ) → low
    const t4 = tryTier(stats.byTitleGroup, stepGroupKeyOf(step), '同じ題の工程');
    if (t4) {
      return out(t4.sec, ESTIMATE_SOURCE.STEP_GROUP, t4.e.n, 'low',
        `${notes.length ? notes.join('・') + '。' : ''}同じ題の工程をまとめた実績 ${t4.e.n}件の${m}(「手順書も型式も違う物が混ざる」)`,
        { groupLevel: 'title-group', qualityMix: t4.e.qualityMix });
    }
  }

  const note = notes.length ? `${notes.join('・')}。` : '';

  // ⑤ テンプレート目標
  const target = Number(step && step.targetTime);
  if (Number.isFinite(target) && target > 0) {
    return out(target, ESTIMATE_SOURCE.TEMPLATE_TARGET, 0, 'low',
      `${note}実績が足りないのでテンプレートの目標時間。**測った値ではない**(実績P75÷目標は工程により0.07〜5.42倍)`);
  }

  // ⑥ 不明。🚨 60秒などを入れない(T030)
  return out(null, ESTIMATE_SOURCE.MISSING, 0, 'unknown',
    `${note}実績も目標時間も無い。**分かりません**(数字を作らない)`);
}

/**
 * 画面と原因分類のための集計。「何件が実績由来か / 何件が目標由来か / 何件が不明か」。
 * @param {DurationEstimate[]} estimates
 */
export function summarizeEstimates(estimates) {
  const list = asArray(estimates);
  const bySource = {};
  const byConfidence = {};
  list.forEach((e) => {
    const s = str(e && e.source) || ESTIMATE_SOURCE.MISSING;
    const c = str(e && e.confidence) || 'unknown';
    bySource[s] = (bySource[s] || 0) + 1;
    byConfidence[c] = (byConfidence[c] || 0) + 1;
  });
  return {
    total: list.length,
    bySource,
    byConfidence,
    /** 実績(測った値)から出した件数 */
    measuredCount: (bySource[ESTIMATE_SOURCE.MODEL_STEP] || 0) + (bySource[ESTIMATE_SOURCE.STEP_GROUP] || 0),
    /** 測っていない値(較正値・目標時間)から出した件数 */
    unmeasuredCount: (bySource[ESTIMATE_SOURCE.CALIBRATED] || 0) + (bySource[ESTIMATE_SOURCE.TEMPLATE_TARGET] || 0),
    /** 分からない件数。🚨これを0扱いしない */
    missingCount: bySource[ESTIMATE_SOURCE.MISSING] || 0,
    lowConfidenceCount: (byConfidence.low || 0) + (byConfidence.unknown || 0),
  };
}
