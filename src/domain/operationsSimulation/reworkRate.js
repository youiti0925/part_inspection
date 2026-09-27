// =============================================================================
// 🔁 修正(1回で通らず、もう一度やった分)の発生率 — 過去の実績だけから数える
// -----------------------------------------------------------------------------
// なぜ要るか:
//   いまのシミュレーションは「1回で正しく終わる」前提で山を積んでいる。
//   でも現場では、通らなくて もう一度やる事が実際に在り、その記録は
//   すでにロットの中(`task.reworks`)に入っている。
//   ここは その記録を数えて「この工程は何回に1回、何分ぶん余計にかかるか」を出すだけ。
//
// 🚨 言葉の約束(2026-09-09 清水さんの指摘):
//   画面に出す言葉は **「修正」**。`reworks` は保存されている鍵の名前でしかない。
//   戻り値の文言も「修正」で揃える。
//
// 🚨 決めるのは人。ここは「過去はこうだった」を出すだけ。
//   ・既定は `mode:'off'` で **1ミリも動かない**(素通り)。
//   ・記録の件数が少ない鍵は `enough:false` にして **使わない**。
//     4件の記録で「この工程は3割やり直す」と言い切ると、それを見て段取りが狂う。
//   ・鍵が引けない/記録が足りない時は、黙って全体の数字へ落とさない。
//     どうしても落としたい呼び出し側だけ `useAll:true` を渡す(既定は false)。
//
// 🚨 数え方は `src/domain/dailyWork.js` の `reworkEntries` / `reworkSecondsInRange` と **同じ読み方**。
//   ・`task.reworks[].duration` が **0より大きい物だけ** 数える。
//   ・保存されている **生の欄** `task.duration` には修正の時間は入っていない
//     (修正完了の処理は reworks にだけ足す。dailyWork.js:57 の注記と同じ)。
//
// 🚨🚨🚨 二重計上の穴(2026-09-10 検算役2人の指摘。ここで塞いだ)
//   「`task.duration` に入っていない」は **生の欄については正しい**。
//   ところが **掛ける相手が生の欄ではなかった**。
//     estimate.js:166 `taskDurationSec(task)` = `task.duration` ＋ `Σ reworks[].duration`
//   見積り(`estimateDuration().seconds`)はこの値の分位点なので、
//   **見積りには すでに修正の時間が入っている**。
//   そこへ「発生率 × 1件あたりの修正時間」を足すと、修正を **2回** 数える事になる。
//   実測(この写し)では 素の合計 644.0時間 に対し 修正 53.1時間。二重に足すと 8.2% ぶん水増しされる。
//
//   → だから `applyReworkRate` は **土台が素(修正を抜いた値)である事を呼ぶ側に言わせる**。
//     ・`baseIncludesRework:false` … 素だと言い切った時だけ 上乗せする。
//     ・`baseIncludesRework:true`  … 掛けずに返す(`code:'base-includes-rework'`)。
//     ・言わなかった時              … 掛けずに返す(`code:'base-not-declared'`)。
//   → 素の土台が要る呼び出し側の為に `rawBaseSec()` を用意した。
//     これは **修正の時間を抜いた `task.duration` だけ** の中央値/上から4分の1。
//   ⚠ 「修正込みの見積り」が欲しいだけなら、estimate.js の見積りを **そのまま使う**。
//     ここを呼ぶ必要は無い(呼ぶと二重になる)。
//
// -----------------------------------------------------------------------------
// 本番の写しで実測(2026-09-10_0100 / product-inspection-v1 / 読むだけ)
// -----------------------------------------------------------------------------
//   ロット 603件 / タスク 7,423件 → 完了 7,067件 → 工程が決まった物 7,022件(決まらない45件)
//   修正が入っているタスク  **279件 / 7,022件 = 4.0%**
//   修正の記録             393件(1回目279・2回目76・3回目23・4回目7・5回目4・6〜9回目 各1)
//                          ⚠ duration が 0以下 で数えなかった記録が 4件
//   1タスクぶんの修正時間   中央値 **391秒(6.5分)** / 上から4分の1 723秒 / 最長 9,755秒(2.7時間)
//     ⚠ 分位点は estimate.js の線形補間をそのまま使う(単純中央値なら367秒。定義を増やさない)
//   素の工数の合計 644.0時間 に対して 修正の合計 53.1時間 = **8.2%**
//   工程の鍵 191本のうち 修正の実績が在るのは 22本。**そのうち使えるのは6本**
//   型式×工程 1,053本のうち 実績が在るのは 79本。**そのうち使えるのは16本**
//   一番高い工程: 「分割自動測定開始」 360件中160件 = 44.4%(中央値 443秒 / 上から4分の1 787秒)
//   この上乗せを全部の完了タスクへ入れると **中央値で +5.47%(35.2時間) / 上から4分の1で +8.46%(54.5時間)**
//     (7,007件のうち 936件に掛かる。残りは記録が足りないので素通り)
//     ⚠ 2026-09-10 に数え直した値。前は「620件・+3.63%」と書いてあったが、これは
//       **型式×工程が薄いだけで打ち切って工程の数字へ落ちていなかった**時の数字。
//       落ち方を直したので、掛かる件数が 620件 → 936件に増えた。
//   素の土台(修正を抜いた `task.duration`。rawBaseSec が返す値)
//     採れた作業 5,732件 / 記録の質で外した 1,275件(estimate.js と同じ条件)
//     全体の素の中央値 **231秒** / 上から4分の1 360秒
//     工程の鍵 191本のうち 素の土台が5件以上あるのは **105本**
//     例) 「分割自動測定開始」素の中央値 360秒(272件)。修正1回の中央値 443秒 は これとは別の量。
//
// ⚠ ここには React も firebase も import しない(node --test で回すため)。
// ⚠ 関数の中で今の時刻も乱数も読まない(同じ入力なら毎回同じ答え)。
// =============================================================================

// 🚨 工程の当て方と鍵の組み方は **既存の物をそのまま使う**。
//   自前で当て直すと、見積り(estimate.js)と鍵がズレて別工程の数字を掴む。
import { resolveTaskProcess, processKeyOf } from '../soloDependency.js';
// 🚨 分位点の定義もアプリ内で増やさない(estimate.js の線形補間を1つだけ使う)。
import { percentile, modelStepKeyOf, ACCEPTED_QUALITY } from './estimate.js';
// 🚨 素の土台(rawBaseSec)を採る条件は estimate.js が見積りに使う記録と同じにする。
//    記録の質の見方を自前で決め直すと、同じ工程なのに件数が違う数字が2つ出る。
import { taskTimeQualityOf } from '../taskTimeQuality.js';

const str = (v) => (v == null ? '' : String(v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/**
 * 「この鍵の記録は足りている」と言ってよい最低件数。
 * ⚠ ここを下げると、1〜2件の記録で発生率を言い切る事になる。
 */
export const MIN_SAMPLES = 5;
/** 別名。⚠ interruptionRate.js も MIN_SAMPLES を出しているので、両方を取り込む所はこちらを使う。 */
export const REWORK_MIN_SAMPLES = MIN_SAMPLES;

/**
 * 上乗せの仕方。
 *   OFF    … 素通り(既定)。1ミリも足さない。
 *   MEDIAN … 発生率 × 1回あたりの中央値 を足す(ふつうの見込み)
 *   P75    … 発生率 × 1回あたりの上から4分の1の値 を足す(用心して厚めに見る)
 */
export const REWORK_MODE = Object.freeze({ OFF: 'off', MEDIAN: 'median', P75: 'p75' });
export const DEFAULT_REWORK_MODE = REWORK_MODE.OFF;

/** 工程の鍵(テンプレ+工程)。estimate.js の ③ と同じ。 */
export const reworkStepKeyOf = (templateId, stepId) => processKeyOf(templateId, stepId);
/** 型式×工程の鍵。estimate.js の ② と同じ。 */
export const reworkModelStepKeyOf = (model, templateId, stepId) => modelStepKeyOf(model, templateId, stepId);

/**
 * 1つのタスクに入っている修正の時間(秒)と回数。
 * 🚨 dailyWork.reworkEntries と同じ読み方。0以下は数えない。
 * @returns {{ sec:number, rounds:number, dropped:number }}
 */
export const reworkOfTask = (task) => {
  const list = asArray(task && task.reworks);
  let sec = 0;
  let rounds = 0;
  let dropped = 0;
  for (const r of list) {
    const d = Number(r && r.duration);
    if (Number.isFinite(d) && d > 0) { sec += d; rounds += 1; } else { dropped += 1; }
  }
  return { sec, rounds, dropped };
};

/**
 * 素の所要秒(**修正の時間を抜いた** `task.duration` だけ)。
 * 🚨 estimate.js の `taskDurationSec` は `duration + reworks` を返す。こちらは **足さない**。
 *    名前を似せてあるのは対で読ませる為。取り違えると二重計上に戻る。
 * @returns {number|null} 0以下・読めない物は null
 */
export const rawTaskDurationSec = (task) => {
  if (!isObj(task)) return null;
  const base = Number(task.duration);
  return (Number.isFinite(base) && base > 0) ? base : null;
};

/** 束を1つ作る/足す。 */
const bump = (map, key, meta, hit, sec, rawSec) => {
  let e = map.get(key);
  if (!e) { e = { key, ...meta, n: 0, hit: 0, rounds: 0, secs: [], rawSecs: [] }; map.set(key, e); }
  e.n += 1;
  if (hit > 0) { e.hit += 1; e.rounds += hit; e.secs.push(sec); }
  if (rawSec != null) e.rawSecs.push(rawSec);
  return e;
};

/** 束を画面と計算で使う形に閉じる。⚠ 生の並びは外へ出さない(並べ替えで壊されない為)。 */
const seal = (e, minSamples) => {
  const rate = e.n > 0 ? e.hit / e.n : 0;
  const medianSec = e.secs.length ? Math.round(percentile(e.secs, 0.5)) : null;
  const p75Sec = e.secs.length ? Math.round(percentile(e.secs, 0.75)) : null;
  // 🚨 **素の**(修正を抜いた)所要秒。上乗せを掛ける相手はこちらでなければならない。
  const raws = asArray(e.rawSecs);
  const rawMedianSec = raws.length ? Math.round(percentile(raws, 0.5)) : null;
  const rawP75Sec = raws.length ? Math.round(percentile(raws, 0.75)) : null;
  // 🚨 「足りている」は **分母と件数の両方**。分母だけ多くても、修正の実績が1件では
  //   1回あたりの時間がその1件そのものになる。
  const enough = e.n >= minSamples && e.hit >= minSamples;
  return {
    key: e.key,
    model: e.model,
    templateId: e.templateId,
    stepId: e.stepId,
    title: e.title,
    n: e.n,
    hit: e.hit,
    rounds: e.rounds,
    rate,
    medianSec,
    p75Sec,
    // 素の土台(修正を抜いた `task.duration` だけ)。記録の質が採れる物だけを数えた件数も添える。
    rawN: raws.length,
    rawMedianSec,
    rawP75Sec,
    enough,
    note: e.hit > 0
      ? `過去 ${e.n}件のうち ${e.hit}件（${(rate * 100).toFixed(1)}%）で修正がありました。1件あたり 中央値 ${medianSec}秒`
      : `過去 ${e.n}件に修正の記録はありません`,
  };
};

/**
 * 修正の発生率を、確定した実績だけから数える。
 *
 * @param {object} args
 * @param {Array} args.lots 生のロット(**完了ロットも含める**。履歴なので外さない)
 * @param {number} [args.minSamples] 既定 5
 * @param {string[]} [args.acceptStatuses] 数える状態。既定 ['completed']
 * @returns {{
 *   byStep: Object<string, object>,
 *   byModelStep: Object<string, object>,
 *   all: object,
 *   minSamples: number,
 *   warnings: Array<{code:string, text:string}>,
 *   diagnostics: object
 * }}
 *   ⚠ 束は Map ではなく素の物にして返す(Worker の向こうへそのまま渡せる形にする為)。
 */
export function buildReworkRate({ lots, minSamples = MIN_SAMPLES, acceptStatuses = ['completed'] } = {}) {
  const min = Number.isFinite(Number(minSamples)) && Number(minSamples) >= 1 ? Math.floor(Number(minSamples)) : MIN_SAMPLES;
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');

  const okQ = new Set(asArray(ACCEPTED_QUALITY).map((v) => str(v).trim()).filter(Boolean));

  const byStep = new Map();
  const byModelStep = new Map();
  const allBucket = { key: '(全体)', title: '(全体)', n: 0, hit: 0, rounds: 0, secs: [], rawSecs: [] };

  const diagnostics = {
    lotsSeen: 0,
    tasksSeen: 0,
    tasksAccepted: 0,
    tasksResolved: 0,
    tasksUnresolved: 0,
    tasksWithRework: 0,
    reworkRounds: 0,
    reworkSecTotal: 0,
    baseSecTotal: 0,
    droppedRounds: 0,
    /** 素の土台に採れた作業の数(記録の質は estimate.js が見積りに使う記録と同じ条件) */
    rawBaseSamples: 0,
    /** 記録の質で素の土台から外した数 */
    rawBaseDroppedByQuality: 0,
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
      if (!r.resolved) { diagnostics.tasksUnresolved += 1; return; }
      diagnostics.tasksResolved += 1;

      const rw = reworkOfTask(task);
      diagnostics.droppedRounds += rw.dropped;
      const base = Number(task.duration);
      diagnostics.baseSecTotal += (Number.isFinite(base) && base > 0) ? base : 0;
      if (rw.rounds > 0) {
        diagnostics.tasksWithRework += 1;
        diagnostics.reworkRounds += rw.rounds;
        diagnostics.reworkSecTotal += rw.sec;
      }

      // 🚨 素の土台に入れてよいか。記録の質は estimate.js が見積りに使う記録と **同じ条件**で見る
      //   (自前で決め直すと、同じ工程で件数の違う数字が2つ出る)。
      const rawSec = rawTaskDurationSec(task);
      let rawForBucket = null;
      if (rawSec != null) {
        const quality = str((taskTimeQualityOf(task) || {}).quality) || 'missing';
        if (okQ.has(quality)) { rawForBucket = rawSec; diagnostics.rawBaseSamples += 1; }
        else diagnostics.rawBaseDroppedByQuality += 1;
      }

      const step = r.step || {};
      const sid = str(r.stepId);
      const title = str(step.title);
      bump(byStep, reworkStepKeyOf(templateId, sid), { templateId, stepId: sid, title }, rw.rounds, rw.sec, rawForBucket);
      bump(byModelStep, reworkModelStepKeyOf(model, templateId, sid), { model, templateId, stepId: sid, title }, rw.rounds, rw.sec, rawForBucket);
      allBucket.n += 1;
      if (rw.rounds > 0) { allBucket.hit += 1; allBucket.rounds += rw.rounds; allBucket.secs.push(rw.sec); }
      if (rawForBucket != null) allBucket.rawSecs.push(rawForBucket);
    });
  });

  const out = (map) => {
    const o = {};
    for (const e of map.values()) o[e.key] = seal(e, min);
    return o;
  };
  const sealedStep = out(byStep);
  const sealedModelStep = out(byModelStep);
  const all = seal(allBucket, min);

  // ── 気がかりを黙って飲み込まない ────────────────────────────────────────
  const warnings = [];
  if (diagnostics.lotsSeen === 0) {
    warnings.push({ code: 'no-lots', text: 'ロットが1件も渡されていません。修正の発生率は出しません' });
  }
  if (diagnostics.tasksResolved === 0 && diagnostics.tasksAccepted > 0) {
    warnings.push({ code: 'no-step', text: `${diagnostics.tasksAccepted}件のタスクの工程が1件も決まりませんでした（steps が渡されていません）` });
  }
  if (diagnostics.tasksUnresolved > 0) {
    warnings.push({ code: 'unresolved', text: `工程が決まらなかったタスクが ${diagnostics.tasksUnresolved}件あります（数に入れていません）` });
  }
  if (diagnostics.droppedRounds > 0) {
    warnings.push({ code: 'zero-duration', text: `修正の記録のうち ${diagnostics.droppedRounds}件は時間が入っていないので数えていません` });
  }
  const thin = Object.values(sealedStep).filter((e) => e.hit > 0 && !e.enough).length;
  if (thin > 0) {
    warnings.push({ code: 'thin', text: `修正の実績はあるが記録が ${min}件に届かない工程が ${thin}本あります（使いません）` });
  }
  if (!all.enough) {
    warnings.push({ code: 'all-thin', text: `全体でも修正の記録が ${all.hit}件で、${min}件に届きません` });
  }

  return { byStep: sealedStep, byModelStep: sealedModelStep, all, minSamples: min, warnings, diagnostics };
}

/**
 * 鍵の受け取り。文字でも {model,templateId,stepId} でも受ける。
 * 戻りは **細かい順**(型式×工程 → 工程)の候補。
 *
 * 🚨🚨 ここで「最初に見つかった束」で打ち切ってはいけない(2026-09-10 に塞いだ穴)。
 *   型式×工程が薄い(enough:false)だけで打ち切ると、記録が足りている工程の数字へ
 *   **落ちずに素通り**する。workerSpeed.js の applyWorkerSpeed は
 *   `e.enough` を確かめてから次の段へ落ちている。同じ作りに揃える。
 */
// ⚠ 素の物への添字引きは自前の鍵しか許さない。'__proto__' の様な名前を鍵として渡されると
//   Object.prototype が束のふりをして返ってくる(件数も enough も無い物が計算へ入る)。
const ownEntry = (obj, k) => (Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);

const candidatesOf = (key, rates) => {
  const byModelStep = isObj(rates && rates.byModelStep) ? rates.byModelStep : {};
  const byStep = isObj(rates && rates.byStep) ? rates.byStep : {};
  const out = [];
  const push = (source, e) => { if (isObj(e)) out.push({ source, entry: e }); };
  if (typeof key === 'string') {
    push('model-step', ownEntry(byModelStep, key));
    push('step', ownEntry(byStep, key));
    return out;
  }
  if (isObj(key)) {
    const t = str(key.templateId);
    const s = str(key.stepId);
    const m = str(key.model);
    if (m && t && s) push('model-step', ownEntry(byModelStep, reworkModelStepKeyOf(m, t, s)));
    if (t && s) push('step', ownEntry(byStep, reworkStepKeyOf(t, s)));
  }
  return out;
};

/**
 * 「記録が足りている束」を細かい順に選ぶ。無ければ、頼まれた時だけ全体へ落ちる。
 * @returns {{ hit:object|null, source:string, thin:object|null }}
 *   thin = 見つかったが記録が足りなかった **一番細かい** 束(何件だったかを言う為)
 */
const pickBucket = (key, rates, useAll) => {
  let thin = null;
  for (const c of candidatesOf(key, rates)) {
    if (c.entry.enough) return { hit: c.entry, source: c.source, thin };
    if (!thin) thin = c.entry;
  }
  // ⚠ 全体も足りていなければ落とさない(落ち先が空なら黙って0件の数字を使う事になる)。
  if (useAll && isObj(rates.all) && rates.all.enough) return { hit: rates.all, source: 'all', thin };
  return { hit: null, source: thin ? 'thin' : 'none', thin };
};

/**
 * 素の土台(**修正の時間を抜いた** 実績の中央値/上から4分の1)を引く。
 *
 * 🚨 これは estimate.js の見積りとは **別の数字**。
 *   estimate.js の見積りは `duration + reworks` の分位点(=修正込み)。
 *   ここは `task.duration` だけの分位点(=修正抜き)。
 *   `applyReworkRate` に渡してよい土台は **こちら** だけ。
 *
 * @param {object} rates buildReworkRate の戻り値
 * @param {string|{model?:string,templateId?:string,stepId?:string}} key 工程の鍵
 * @param {{ mode?:'median'|'p75', useAll?:boolean }} [opts]
 * @returns {{ sec:number|null, n:number, source:string, why:string }}
 */
export function rawBaseSec(rates, key, { mode = REWORK_MODE.MEDIAN, useAll = false } = {}) {
  if (!isObj(rates)) return { sec: null, n: 0, source: 'none', why: '修正の実績が渡されていません' };
  const wantP75 = str(mode).trim() === REWORK_MODE.P75;
  const label = wantP75 ? '上から4分の1' : '中央値';
  const min = Number(rates.minSamples) || MIN_SAMPLES;
  const take = (e, source) => {
    // 🚨 素の土台も件数が足りなければ使わない。1件の中央値はその1件そのもの。
    if (!((Number(e.rawN) || 0) >= min)) return null;
    const sec = wantP75 ? e.rawP75Sec : e.rawMedianSec;
    if (!Number.isFinite(Number(sec)) || Number(sec) <= 0) return null;
    return {
      sec: Number(sec),
      n: Number(e.rawN) || 0,
      source,
      why: `修正の時間を抜いた素の実績 ${Number(e.rawN) || 0}件の${label} ${Number(sec)}秒`,
    };
  };
  for (const c of candidatesOf(key, rates)) {
    const got = take(c.entry, c.source);
    if (got) return got;
  }
  if (useAll && isObj(rates.all)) {
    const got = take(rates.all, 'all');
    if (got) return got;
  }
  return { sec: null, n: 0, source: 'none', why: 'この工程の素の実績が見つかりません' };
}

/**
 * 素の工数へ「修正のぶん」を上乗せする。
 *
 * 🚨 既定は `mode:'off'` で **素通り**。渡さなければ 1ミリも動かない。
 * 🚨🚨 土台は **素(修正を抜いた値)でなければならない**。呼ぶ側が `baseIncludesRework:false`
 *    と言い切った時だけ上乗せする。言わない/入っていると言われた時は **掛けずに返す**。
 *    estimate.js の見積り(`estimateDuration().seconds`)は `duration + reworks` の分位点なので
 *    **すでに修正が入っている**。そのまま渡すと二重になる。素の土台は `rawBaseSec()` で引く。
 * 🚨 記録が足りない鍵は使わない(`enough:false` → 1つ粗い束へ落ちる → 無ければ素通り)。
 * 🚨 足すのは「発生率 × 1件あたりの修正時間」。
 *    毎回 修正時間まるごとを足すのは、10回に1回しか起きない事を毎回起きる事にしてしまう。
 *
 * @param {number|null} baseSec **素の**工数(秒)。`rawBaseSec()` が出した値
 * @param {object} args
 * @param {string|{model?:string,templateId?:string,stepId?:string}} args.key 工程の鍵
 * @param {object} args.rates buildReworkRate の戻り値
 * @param {'off'|'median'|'p75'} [args.mode] 既定 'off'
 * @param {boolean} [args.useAll] 鍵が引けない時に全体の数字へ落とすか。既定 false
 * @param {boolean} [args.baseIncludesRework] 土台に修正の時間が入っているか。
 *   **false と言い切った時だけ上乗せする**。既定は「言われていない」= 上乗せしない
 * @returns {{ sec:number|null, applied:boolean, why:string, extraSec:number, source:string, code:string }}
 *   code … 'applied' / 'off' / 'base-includes-rework' / 'base-not-declared' / 'no-base' /
 *          'no-rates' / 'thin' / 'no-key' / 'no-per-sec'
 */
export function applyReworkRate(
  baseSec,
  { key, rates, mode = DEFAULT_REWORK_MODE, useAll = false, baseIncludesRework } = {},
) {
  const passthrough = (why, source, code) => ({
    sec: baseSec == null ? null : Number(baseSec), applied: false, why, extraSec: 0, source, code,
  });

  const m = str(mode).trim();
  if (m !== REWORK_MODE.MEDIAN && m !== REWORK_MODE.P75) {
    return passthrough('修正の上乗せは切ってあります（そのままの工数です）', 'off', 'off');
  }
  // 🚨🚨 二重計上の門。ここを緩めると「修正込みの見積り」へもう一度修正を足す事になる。
  if (baseIncludesRework === true) {
    return passthrough(
      'この工数には すでに修正の時間が入っています（見積りは 作業時間＋修正 の実績から出ています）。'
      + '二重になるので上乗せしません',
      'base-includes-rework',
      'base-includes-rework',
    );
  }
  if (baseIncludesRework !== false) {
    return passthrough(
      'この工数に修正の時間が入っているかが分かりません。二重に足さない為に上乗せしません'
      + '（素の工数なら baseIncludesRework:false と言ってください）',
      'base-not-declared',
      'base-not-declared',
    );
  }
  const base = Number(baseSec);
  if (!Number.isFinite(base) || base <= 0) {
    return passthrough('もとの工数が分かりません。上乗せもしません', 'none', 'no-base');
  }
  if (!isObj(rates)) {
    return passthrough('修正の実績が渡されていません', 'none', 'no-rates');
  }

  const picked = pickBucket(key, rates, useAll);
  let hit = picked.hit;
  const source = picked.source;
  if (!hit) {
    const min = Number(rates.minSamples) || MIN_SAMPLES;
    const why = picked.thin
      ? `記録が ${picked.thin.n}件・修正 ${picked.thin.hit}件で、${min}件に届きません。上乗せもしません`
      : 'この工程の記録が見つかりません。上乗せもしません';
    return passthrough(why, source, picked.thin ? 'thin' : 'no-key');
  }
  const per = m === REWORK_MODE.P75 ? hit.p75Sec : hit.medianSec;
  if (!Number.isFinite(Number(per)) || Number(per) <= 0) {
    return passthrough('1件あたりの修正時間が分かりません。上乗せもしません', 'thin', 'no-per-sec');
  }
  const extraSec = Math.round(hit.rate * Number(per));
  const label = m === REWORK_MODE.P75 ? '上から4分の1' : '中央値';
  return {
    sec: base + extraSec,
    applied: true,
    why: `過去 ${hit.n}件のうち ${hit.hit}件（${(hit.rate * 100).toFixed(1)}%）で修正がありました。`
      + `1件あたり ${label} ${per}秒 を発生率ぶん（${extraSec}秒）足しました`,
    extraSec,
    source,
    code: 'applied',
  };
}

/**
 * 「この上乗せを入れると、全体の工数が何%増えるか」。
 * ⚠ 画面へ数字を出す時は、必ずこの1本から出す(手で掛け算しない)。
 * 🚨 土台は **`task.duration`(素の欄)**。修正の時間は入っていないので
 *   `baseIncludesRework:false` と言い切って渡す。ここを estimate.js の見積りに
 *   すり替えると二重計上になる。
 * @returns {{ tasks:number, appliedTasks:number, baseSec:number, addedSec:number, ratio:number }}
 */
export function reworkTotalImpact({ lots, rates, mode = DEFAULT_REWORK_MODE, useAll = false, acceptStatuses = ['completed'] } = {}) {
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');
  let tasks = 0;
  let appliedTasks = 0;
  let baseSec = 0;
  let addedSec = 0;
  asArray(lots).forEach((lot) => {
    if (!isObj(lot)) return;
    const steps = asArray(lot.steps);
    const templateId = str(lot.templateId);
    const model = str(lot.model);
    const tasksMap = isObj(lot.tasks) ? lot.tasks : {};
    Object.entries(tasksMap).forEach(([taskKey, task]) => {
      if (!isObj(task) || !ok.has(str(task.status))) return;
      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) return;
      const b = Number(task.duration);
      if (!Number.isFinite(b) || b <= 0) return;
      tasks += 1;
      baseSec += b;
      const got = applyReworkRate(b, {
        key: { model, templateId, stepId: str(r.stepId) }, rates, mode, useAll, baseIncludesRework: false,
      });
      if (got.applied) { appliedTasks += 1; addedSec += got.extraSec; }
    });
  });
  return { tasks, appliedTasks, baseSec, addedSec, ratio: baseSec > 0 ? addedSec / baseSec : 0 };
}

/**
 * 画面に出す1行(工程ごと)。⚠ 数字は全部ここまでで数えた物から作る(手書きしない)。
 * @param {object} rates buildReworkRate の戻り値
 * @param {{ onlyWithRework?:boolean, limit?:number }} [opts]
 */
export function reworkRateRows(rates, { onlyWithRework = true, limit = 0 } = {}) {
  const src = isObj(rates) && isObj(rates.byStep) ? Object.values(rates.byStep) : [];
  const rows = src
    .filter((e) => (onlyWithRework ? e.hit > 0 : true))
    .map((e) => ({
      key: e.key,
      title: e.title || e.stepId,
      templateId: e.templateId,
      stepId: e.stepId,
      n: e.n,
      hit: e.hit,
      rounds: e.rounds,
      ratePercent: Math.round(e.rate * 1000) / 10,
      medianSec: e.medianSec,
      p75Sec: e.p75Sec,
      enough: e.enough,
      note: e.enough ? e.note : `${e.note}（記録が少ないので計算には使いません）`,
    }))
    .sort((a, b) => (b.ratePercent - a.ratePercent) || (b.n - a.n) || String(a.title).localeCompare(String(b.title), 'ja'));
  const n = Number(limit);
  return (Number.isFinite(n) && n > 0) ? rows.slice(0, n) : rows;
}
