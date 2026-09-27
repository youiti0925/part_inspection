// =============================================================================
// ⏸ 中断(部品待ち・不具合対応で止まっていた時間)の発生率 — 過去の実績だけから数える
// -----------------------------------------------------------------------------
// なぜ要るか:
//   いまのシミュレーションは「止まらない」前提で山を積んでいる。
//   でも現場では実際に止まっていて、その記録は すでにロットの中(`lot.interruptions`)に在る。
//
// 🚨🚨 中断は **「働いた時間」ではない**。
//   だから **工数(人が手を動かす秒数)へ足してはいけない**。足すと
//   「その日 何人ぶんの手が要るか」が水増しされ、人が足りないという嘘になる。
//   ここでするのは **終わる時刻を後ろへずらす** 事だけ。
//   ⚠ ずらすのは **実時間(壁の時計)**。中断は勤務時間の外でも進む(部品を待っている間、
//     夜も土日も待っている)。だから calendar.js の稼働時間へは通さない。
//
// 🚨 決めるのは人。ここは「過去はこうだった」を出すだけ。
//   ・既定は `mode:'off'` で **1ミリも動かない**(素通り)。
//   ・記録の件数が少ない鍵は `enough:false` にして **使わない**。
//
// 🚨 数え方は `src/domain/dailyWork.js` の `interruptionEntries` と **同じ読み方**。
//   ・記録の `duration` が **0より大きい物だけ** 数える。
//     0の物は「報告は上げたが、止まっていた時間が記録されていない」物。
//     0を「止まらなかった」と読むと、実際に止まった事まで消える。だから **数えない**(捨てた数は warnings に出す)。
//   ・工程は 記録の `stepInfo.stepId` + ロットの `templateId`。
//
// 🚨🚨🚨 どこから読むか(2026-09-10 検算役の指摘。ここで塞いだ)
//   2026-08-14 以降、アプリは中断を **`lot.interruptionsMap` にしか書かない**
//   (interruptionLog.js の `intWritePatch` が返すのは map だけ。配列は多端末で
//    まるごと置換されて消えるので書かなくなった)。
//   `lot.interruptions`(古い配列)だけを読むと:
//     ① 新しい記録が **1件も見えない**(map にしか無い)。
//     ② 台帳で消した記録は map の **墓標(deleted:true)** なので、配列側の写しが残っていて
//        **消したはずの記録を数え直す**。
//   → 合流は自前でやらず、同じ repo の `mergeInterruptionLog(配列, map)` をそのまま使う。
//     鍵が同じ記録は map 側が勝ち、墓標は落ち、**重複して数えない**。
//
// -----------------------------------------------------------------------------
// 本番の写しで実測(2026-09-10_0100 / product-inspection-v1 / 読むだけ)
// -----------------------------------------------------------------------------
//   ⚠ 2026-09-10 に **合流後(配列 ⊕ interruptionsMap)で数え直した**。配列だけを見ていた時の
//     数字(記録が在るロット47件・記録89件)は、新しい形で書かれた1件を落としていた。
//   ロット 603件のうち 中断の記録が在るのは **48件**
//   中断の記録 **90件**(古い配列 89件 ＋ 新しい一覧にしか無い 1件。
//     消した印(墓標) 0件・両方に在って1件にまとめた物 0件)
//     ⚠ この写しでは map 側がまだ1件しか無い。これから増える(アプリはもう map にしか書かない)。
//   うち **止まっていた時間が入っているのは 18件**(12ロット)
//     ⚠ 残り72件は時間が 0。種類の内訳は 苦情68・不具合12・改善9・見守り1、
//       状態は 報告済72・完了13・対応中5。**時間まで入れているのは2割(20.0%)だけ**。
//   1件の中央値 **2,011秒(33.5分)** / 上から4分の1 9,816秒(164分) / 最短 2秒 / 最長 89,424秒(24.8時間)
//   止まっていた時間の合計 **61.0時間**
//   工程の鍵は 90件すべてに入っている(stepInfo.stepId が全件在る)
//   記録が乗る工程の鍵は **7本**(＋分母が0の工程が1本)。
//     そのうち 分母5件以上・中断5件以上・時間の入り具合5割以上 を満たすのは **1本だけ**
//     (「準備」分母320件・報告13件・時間入り8件(61.5%) = 2.5%・中央値9秒)。
//   → いまの写しでは **工程ごとに使える数字はほぼ無い**。
//   🚨 全体(all)は **使えない**。18件/7,022タスク = 0.26% に見えるが、
//     これは「止まった率」ではなく「時間まで入れてくれた率」(報告90件中18件=20.0%)。
//     だから `all.enough` は false になり、`useAll:true` と頼まれても落とさない。
//
// ⚠ ここには React も firebase も import しない(node --test で回すため)。
// ⚠ 関数の中で今の時刻も乱数も読まない(同じ入力なら毎回同じ答え)。
// =============================================================================

// 🚨 工程の当て方と鍵の組み方は **既存の物をそのまま使う**(reworkRate.js と同じ鍵にする)。
import { resolveTaskProcess, processKeyOf } from '../soloDependency.js';
import { percentile, modelStepKeyOf } from './estimate.js';
// 🚨 配列(古い形)と interruptionsMap(新しい形)の合流は **既存の1本** を使う。
//    自前で合流させると、墓標の扱いと鍵の作り方が台帳とズレて数が合わなくなる。
import { mergeInterruptionLog, isIntTombstone, intKeyOf, INT_MAP_FIELD } from '../interruptionLog.js';

const str = (v) => (v == null ? '' : String(v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/** 「この鍵の記録は足りている」と言ってよい最低件数。 */
export const MIN_SAMPLES = 5;
/** 別名。⚠ reworkRate.js も MIN_SAMPLES を出しているので、両方を取り込む所はこちらを使う。 */
export const INTERRUPTION_MIN_SAMPLES = MIN_SAMPLES;

/**
 * 後ろへずらす量の決め方。
 *   OFF    … 素通り(既定)。1ミリもずらさない。
 *   MEDIAN … 発生率 × 1件あたりの中央値
 *   P75    … 発生率 × 1件あたりの上から4分の1の値(用心して厚めに見る)
 */
export const INTERRUPTION_MODE = Object.freeze({ OFF: 'off', MEDIAN: 'median', P75: 'p75' });
export const DEFAULT_INTERRUPTION_MODE = INTERRUPTION_MODE.OFF;

/** 工程の鍵(テンプレ+工程)。reworkRate.js / estimate.js と同じ。 */
export const interruptionStepKeyOf = (templateId, stepId) => processKeyOf(templateId, stepId);
/** 型式×工程の鍵。 */
export const interruptionModelStepKeyOf = (model, templateId, stepId) => modelStepKeyOf(model, templateId, stepId);

/**
 * 1つのロットの中断の記録(**配列 ⊕ interruptionsMap を合流した後**)。
 * 🚨 墓標(deleted:true)は落ちる。同じ記録を2回数えない。
 * ⚠ 時間が入っていない記録も **落とさずに返す**。分母(報告そのものの数)を数える為。
 * @returns {Array<object>} 生の記録
 */
export const interruptionRecordsOfLot = (lot) => {
  if (!isObj(lot)) return [];
  const map = lot[INT_MAP_FIELD];
  const merged = mergeInterruptionLog(lot.interruptions, map);
  return asArray(merged).filter((x) => isObj(x) && !isIntTombstone(x));
};

/** そのロットの map に入っている墓標(=台帳で消された記録)の数。 */
export const interruptionTombstonesOfLot = (lot) => {
  const map = isObj(lot) ? lot[INT_MAP_FIELD] : null;
  if (!isObj(map)) return 0;
  return Object.values(map).filter((v) => isIntTombstone(v)).length;
};

/**
 * 1つのロットに入っている中断のうち「止まっていた時間が入っている物」。
 * 🚨 dailyWork.interruptionEntries と同じ読み方。0以下は数えない。
 * 🚨 読む先は **合流後**(配列 ⊕ interruptionsMap)。配列だけ読むと新しい記録が見えない。
 * @returns {Array<{ sec:number, stepId:string, label:string, kind:string }>}
 */
export const interruptionsOfLot = (lot) => {
  const out = [];
  for (const x of interruptionRecordsOfLot(lot)) {
    const d = Number(x && x.duration);
    if (!Number.isFinite(d) || d <= 0) continue;
    out.push({
      sec: d,
      stepId: str(x && x.stepInfo && x.stepInfo.stepId),
      label: str((x && x.label) || ''),
      kind: str((x && x.type) || ''),
    });
  }
  return out;
};

/**
 * 報告のうち「止まっていた時間まで入っている」割合が、これを下回る束は使わない。
 *
 * 🚨🚨 なぜ件数だけでは足りないか(2026-09-10 検算役の指摘。ここで塞いだ)
 *   この写しでは 中断の報告 90件のうち 時間が入っているのは 18件(2割)。
 *   件数だけで見ると全体は「18件あるから足りている」になるが、
 *   その 18件で出した発生率は **「止まった率」ではなく「時間まで入れてくれた率」**。
 *   8割を落としたまま「この工程は◯%止まる」と言うと、必ず少なく見える。
 *   → 報告のうち時間まで入っている割合(coverage)も見て、低ければ使わない。
 */
export const MIN_DURATION_COVERAGE = 0.5;

/** 束を1つ作る。reported = その束に乗った報告の数(時間が入っていない物も数える)。 */
const bucket = (key, meta) => ({ key, ...meta, n: 0, reported: 0, hit: 0, secs: [] });

/** 束を画面と計算で使う形に閉じる。 */
const seal = (e, minSamples, minCoverage) => {
  const rate = e.n > 0 ? e.hit / e.n : 0;
  const medianSec = e.secs.length ? Math.round(percentile(e.secs, 0.5)) : null;
  const p75Sec = e.secs.length ? Math.round(percentile(e.secs, 0.75)) : null;
  const coverage = e.reported > 0 ? e.hit / e.reported : 0;
  // 🚨 「足りている」は **分母・件数・時間の入り具合** の3つ全部。
  const enough = e.n >= minSamples && e.hit >= minSamples && coverage >= minCoverage;
  const pct = (v) => (v * 100).toFixed(1);
  return {
    key: e.key,
    model: e.model,
    templateId: e.templateId,
    stepId: e.stepId,
    title: e.title,
    n: e.n,
    /** その束に乗った報告の数(時間が入っていない物も含む) */
    reported: e.reported,
    hit: e.hit,
    rate,
    /** 報告のうち 止まっていた時間まで入っている割合 */
    coverage,
    medianSec,
    p75Sec,
    enough,
    note: e.hit > 0
      ? `過去 ${e.n}件のうち ${e.hit}件（${pct(rate)}%）で止まっていました。1件あたり 中央値 ${medianSec}秒`
        + (e.reported > e.hit
          ? `（報告 ${e.reported}件のうち 時間が入っているのは ${e.hit}件＝${pct(coverage)}%。残りは報告だけ）`
          : '')
      : `過去 ${e.n}件に中断の記録はありません`,
  };
};

/**
 * 中断の発生率を、実績だけから数える。
 *
 * 分母は **完了したタスクの件数**(reworkRate.js と同じ数え方)。
 * つまり「この工程を1回やると、何回に1回 止まるか」。
 *
 * @param {object} args
 * @param {Array} args.lots 生のロット(**完了ロットも含める**)
 * @param {number} [args.minSamples] 既定 5
 * @param {string[]} [args.acceptStatuses] 分母に数えるタスクの状態。既定 ['completed']
 * @returns {{
 *   byStep: Object<string, object>,
 *   byModelStep: Object<string, object>,
 *   all: object,
 *   minSamples: number,
 *   warnings: Array<{code:string, text:string}>,
 *   diagnostics: object
 * }}
 */
export function buildInterruptionRate({ lots, minSamples = MIN_SAMPLES, acceptStatuses = ['completed'] } = {}) {
  const min = Number.isFinite(Number(minSamples)) && Number(minSamples) >= 1 ? Math.floor(Number(minSamples)) : MIN_SAMPLES;
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');

  const byStep = new Map();
  const byModelStep = new Map();
  const allBucket = bucket('(全体)', { title: '(全体)' });

  const diagnostics = {
    lotsSeen: 0,
    lotsWithRecord: 0,
    lotsWithDuration: 0,
    lotsWithMap: 0,
    tasksResolved: 0,
    /** 合流後(配列 ⊕ map・墓標を落とした後)の記録の数。⚠ これが「中断の記録」の件数 */
    records: 0,
    /** 古い配列に入っていた数(合流前) */
    recordsInArray: 0,
    /** interruptionsMap に入っていた鍵の数(墓標を含む) */
    recordsInMap: 0,
    /** 台帳で消された記録(墓標)。数に入れていない */
    recordsDeleted: 0,
    /** 配列と map の両方に居た記録(1件として数えた) */
    recordsMergedDuplicates: 0,
    recordsWithDuration: 0,
    recordsWithoutDuration: 0,
    recordsWithoutStep: 0,
    recordsWithoutDenominator: 0,
    interruptionSecTotal: 0,
    kinds: {},
  };

  // ── ① 分母。完了タスクを工程の鍵で数える ────────────────────────────────
  asArray(lots).forEach((lot) => {
    if (!isObj(lot)) return;
    diagnostics.lotsSeen += 1;
    const steps = asArray(lot.steps);
    const templateId = str(lot.templateId);
    const model = str(lot.model);
    const tasks = isObj(lot.tasks) ? lot.tasks : {};
    Object.entries(tasks).forEach(([taskKey, task]) => {
      if (!isObj(task) || !ok.has(str(task.status))) return;
      const r = resolveTaskProcess(taskKey, steps);
      if (!r.resolved) return;
      diagnostics.tasksResolved += 1;
      const sid = str(r.stepId);
      const title = str((r.step || {}).title);
      const sk = interruptionStepKeyOf(templateId, sid);
      if (!byStep.has(sk)) byStep.set(sk, bucket(sk, { templateId, stepId: sid, title }));
      byStep.get(sk).n += 1;
      const mk = interruptionModelStepKeyOf(model, templateId, sid);
      if (!byModelStep.has(mk)) byModelStep.set(mk, bucket(mk, { model, templateId, stepId: sid, title }));
      byModelStep.get(mk).n += 1;
      allBucket.n += 1;
    });
  });

  // ── ② 分子。合流後の記録を数える(時間が入っている物だけを分子に、報告そのものは reported に)
  asArray(lots).forEach((lot) => {
    if (!isObj(lot)) return;
    const arr = asArray(lot.interruptions);
    const mapObj = isObj(lot[INT_MAP_FIELD]) ? lot[INT_MAP_FIELD] : null;
    const mapKeys = mapObj ? Object.keys(mapObj) : [];
    if (mapKeys.length) diagnostics.lotsWithMap += 1;
    diagnostics.recordsInArray += arr.length;
    diagnostics.recordsInMap += mapKeys.length;
    diagnostics.recordsDeleted += interruptionTombstonesOfLot(lot);
    // 配列と map の両方に居た記録の数。
    // ⚠ 引き算で出さない。墓標で消えた記録まで「重複」に混ざる。
    //   鍵の作り方は台帳と同じ intKeyOf を使う(自前で組むとズレる)。
    if (mapObj) {
      for (const e of arr) {
        const ov = mapObj[intKeyOf(e)];
        if (ov !== undefined && !isIntTombstone(ov)) diagnostics.recordsMergedDuplicates += 1;
      }
    }

    // 🚨 合流後。墓標は落ち、同じ記録は1件になる。
    const raw = interruptionRecordsOfLot(lot);
    if (raw.length) diagnostics.lotsWithRecord += 1;
    diagnostics.records += raw.length;
    for (const x of raw) {
      const kind = str((x && x.type) || '(種類なし)');
      diagnostics.kinds[kind] = (diagnostics.kinds[kind] || 0) + 1;
    }
    const templateId = str(lot.templateId);
    const model = str(lot.model);

    // 報告そのもの(時間が入っていない物も)を、その工程の束へ「報告の数」として乗せる。
    for (const x of raw) {
      const sid = str(x && x.stepInfo && x.stepInfo.stepId);
      allBucket.reported += 1;
      if (!sid) continue;
      const se = byStep.get(interruptionStepKeyOf(templateId, sid));
      if (se) se.reported += 1;
      const me = byModelStep.get(interruptionModelStepKeyOf(model, templateId, sid));
      if (me) me.reported += 1;
    }

    const list = interruptionsOfLot(lot);
    if (list.length) diagnostics.lotsWithDuration += 1;
    diagnostics.recordsWithDuration += list.length;
    diagnostics.recordsWithoutDuration += raw.length - list.length;
    for (const it of list) {
      diagnostics.interruptionSecTotal += it.sec;
      allBucket.hit += 1;
      allBucket.secs.push(it.sec);
      if (!it.stepId) { diagnostics.recordsWithoutStep += 1; continue; }
      const sk = interruptionStepKeyOf(templateId, it.stepId);
      const se = byStep.get(sk);
      if (!se) { diagnostics.recordsWithoutDenominator += 1; continue; }
      se.hit += 1;
      se.secs.push(it.sec);
      const mk = interruptionModelStepKeyOf(model, templateId, it.stepId);
      const me = byModelStep.get(mk);
      if (me) { me.hit += 1; me.secs.push(it.sec); }
    }
  });

  const out = (map) => {
    const o = {};
    for (const e of map.values()) o[e.key] = seal(e, min, MIN_DURATION_COVERAGE);
    return o;
  };
  const sealedStep = out(byStep);
  const sealedModelStep = out(byModelStep);
  const all = seal(allBucket, min, MIN_DURATION_COVERAGE);

  // ── 気がかりを黙って飲み込まない ────────────────────────────────────────
  const warnings = [];
  if (diagnostics.lotsSeen === 0) {
    warnings.push({ code: 'no-lots', text: 'ロットが1件も渡されていません。中断の発生率は出しません' });
  }
  if (diagnostics.recordsWithoutDuration > 0) {
    warnings.push({
      code: 'zero-duration',
      text: `中断の記録 ${diagnostics.records}件のうち ${diagnostics.recordsWithoutDuration}件は`
        + '止まっていた時間が入っていないので数えていません（報告だけの物）',
    });
  }
  if (diagnostics.recordsWithoutStep > 0) {
    warnings.push({ code: 'no-step', text: `中断 ${diagnostics.recordsWithoutStep}件は どの工程か分からないので、工程ごとの数には入れていません` });
  }
  if (diagnostics.recordsWithoutDenominator > 0) {
    warnings.push({
      code: 'no-denominator',
      text: `中断 ${diagnostics.recordsWithoutDenominator}件は、その工程の完了タスクが1件も無いので割合を出せません`,
    });
  }
  if (diagnostics.recordsDeleted > 0) {
    warnings.push({
      code: 'deleted',
      text: `台帳で消された中断 ${diagnostics.recordsDeleted}件は数えていません（消した印が付いています）`,
    });
  }
  if (diagnostics.recordsMergedDuplicates > 0) {
    warnings.push({
      code: 'merged-duplicates',
      text: `古い一覧と新しい一覧の両方にあった中断 ${diagnostics.recordsMergedDuplicates}件は、1件として数えました`,
    });
  }
  const thin = Object.values(sealedStep).filter((e) => e.hit > 0 && !e.enough).length;
  if (thin > 0) {
    warnings.push({ code: 'thin', text: `中断の実績はあるが記録が ${min}件に届かない工程が ${thin}本あります（使いません）` });
  }
  if (!all.enough) {
    // 🚨 「件数は足りているが、時間まで入っている報告が少ない」を件数不足と同じ文で
    //   済ませない。直し方が違う(前者は現場に時間の入力を頼む話)。
    if (all.hit >= min && all.coverage < MIN_DURATION_COVERAGE) {
      warnings.push({
        code: 'all-thin-coverage',
        text: `全体の中断 ${all.reported}件のうち、止まっていた時間が入っているのは ${all.hit}件`
          + `（${(all.coverage * 100).toFixed(1)}%）しかありません。`
          + `${Math.round(MIN_DURATION_COVERAGE * 100)}%に届かないので、全体の数字も使いません`,
      });
    } else {
      warnings.push({ code: 'all-thin', text: `全体でも中断の記録が ${all.hit}件で、${min}件に届きません` });
    }
  }

  return { byStep: sealedStep, byModelStep: sealedModelStep, all, minSamples: min, warnings, diagnostics };
}

/**
 * 鍵の受け取り。文字でも {model,templateId,stepId} でも受ける。
 * 戻りは **細かい順**(型式×工程 → 工程)の候補。
 *
 * 🚨🚨 ここで「最初に見つかった束」で打ち切ってはいけない(2026-09-10 に塞いだ穴)。
 *   型式×工程が薄い(enough:false)だけで打ち切ると、記録が足りている工程の数字へ
 *   **落ちずに素通り**する。workerSpeed.js の applyWorkerSpeed と同じ作りに揃える。
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
    if (m && t && s) push('model-step', ownEntry(byModelStep, interruptionModelStepKeyOf(m, t, s)));
    if (t && s) push('step', ownEntry(byStep, interruptionStepKeyOf(t, s)));
  }
  return out;
};

/**
 * 「記録が足りている束」を細かい順に選ぶ。無ければ、頼まれた時だけ全体へ落ちる。
 * @returns {{ hit:object|null, source:string, thin:object|null }}
 */
const pickBucket = (key, rates, useAll) => {
  let thin = null;
  for (const c of candidatesOf(key, rates)) {
    if (c.entry.enough) return { hit: c.entry, source: c.source, thin };
    if (!thin) thin = c.entry;
  }
  // ⚠ 全体も足りていなければ落とさない。
  if (useAll && isObj(rates.all) && rates.all.enough) return { hit: rates.all, source: 'all', thin };
  return { hit: null, source: thin ? 'thin' : 'none', thin };
};

/**
 * 終わる時刻を「中断のぶん」後ろへずらす。
 *
 * 🚨 既定は `mode:'off'` で **素通り**。渡さなければ 1ミリも動かない。
 * 🚨 工数(人が手を動かす秒数)には **足さない**。ここは時刻だけを動かす。
 * 🚨 ずらすのは実時間。稼働カレンダーには通さない(待ちは夜も土日も進む)。
 *
 * @param {number|null} endMs 終わる時刻(epoch ms)
 * @param {object} args
 * @param {string|{model?:string,templateId?:string,stepId?:string}} args.key 工程の鍵
 * @param {object} args.rates buildInterruptionRate の戻り値
 * @param {'off'|'median'|'p75'} [args.mode] 既定 'off'
 * @param {boolean} [args.useAll] 鍵が引けない時に全体の数字へ落とすか。既定 false
 * @returns {{ ms:number|null, applied:boolean, why:string, addedMs:number, source:string }}
 */
export function applyInterruption(endMs, { key, rates, mode = DEFAULT_INTERRUPTION_MODE, useAll = false } = {}) {
  const passthrough = (why, source) => ({ ms: endMs == null ? null : Number(endMs), applied: false, why, addedMs: 0, source });

  const m = str(mode).trim();
  if (m !== INTERRUPTION_MODE.MEDIAN && m !== INTERRUPTION_MODE.P75) {
    return passthrough('中断の見込みは切ってあります（そのままの時刻です）', 'off');
  }
  const base = Number(endMs);
  if (!Number.isFinite(base) || base <= 0) {
    return passthrough('終わる時刻が分かりません。ずらしません', 'none');
  }
  if (!isObj(rates)) {
    return passthrough('中断の実績が渡されていません', 'none');
  }

  // 🚨 記録が足りない鍵は使わない。1つ粗い束へ落ち、それも足りなければ
  //   呼ぶ側が `useAll:true` と言った時だけ 全体の数字へ落ちる。
  const picked = pickBucket(key, rates, useAll);
  const hit = picked.hit;
  const source = picked.source;
  if (!hit) {
    const min = Number(rates.minSamples) || MIN_SAMPLES;
    const t = picked.thin;
    let why = 'この工程の記録が見つかりません。ずらしません';
    if (t) {
      why = (t.hit >= min && t.coverage < MIN_DURATION_COVERAGE)
        ? `中断 ${t.reported}件のうち 止まっていた時間が入っているのは ${t.hit}件だけです。ずらしません`
        : `記録が ${t.n}件・中断 ${t.hit}件で、${min}件に届きません。ずらしません`;
    }
    return passthrough(why, source);
  }
  const per = m === INTERRUPTION_MODE.P75 ? hit.p75Sec : hit.medianSec;
  if (!Number.isFinite(Number(per)) || Number(per) <= 0) {
    return passthrough('1件あたりの中断時間が分かりません。ずらしません', 'thin');
  }
  const addedMs = Math.round(hit.rate * Number(per) * 1000);
  const label = m === INTERRUPTION_MODE.P75 ? '上から4分の1' : '中央値';
  return {
    ms: base + addedMs,
    applied: true,
    why: `過去 ${hit.n}件のうち ${hit.hit}件（${(hit.rate * 100).toFixed(1)}%）で止まっていました。`
      + `1件あたり ${label} ${per}秒 を発生率ぶん（${Math.round(addedMs / 1000)}秒）後ろへずらしました`,
    addedMs,
    source,
  };
}

/**
 * 画面に出す1行(工程ごと)。
 * @param {object} rates buildInterruptionRate の戻り値
 * @param {{ onlyWithInterruption?:boolean, limit?:number }} [opts]
 */
export function interruptionRateRows(rates, { onlyWithInterruption = true, limit = 0 } = {}) {
  const src = isObj(rates) && isObj(rates.byStep) ? Object.values(rates.byStep) : [];
  const rows = src
    .filter((e) => (onlyWithInterruption ? e.hit > 0 : true))
    .map((e) => ({
      key: e.key,
      title: e.title || e.stepId,
      templateId: e.templateId,
      stepId: e.stepId,
      n: e.n,
      reported: e.reported,
      hit: e.hit,
      ratePercent: Math.round(e.rate * 1000) / 10,
      coveragePercent: Math.round((e.coverage || 0) * 1000) / 10,
      medianSec: e.medianSec,
      p75Sec: e.p75Sec,
      medianMinutes: e.medianSec == null ? null : Math.round(e.medianSec / 60),
      enough: e.enough,
      // ⚠ 使わない理由を1つにまとめない。「件数が少ない」と
      //   「時間まで入れた報告が少ない」では、現場でやる事が違う。
      note: e.enough
        ? e.note
        : `${e.note}（${(e.hit >= (Number(rates.minSamples) || MIN_SAMPLES) && e.coverage < MIN_DURATION_COVERAGE)
          ? '止まっていた時間が入っている報告が少ないので'
          : '記録が少ないので'}計算には使いません）`,
    }))
    .sort((a, b) => (b.ratePercent - a.ratePercent) || (b.n - a.n) || String(a.title).localeCompare(String(b.title), 'ja'));
  const n = Number(limit);
  return (Number.isFinite(n) && n > 0) ? rows.slice(0, n) : rows;
}
