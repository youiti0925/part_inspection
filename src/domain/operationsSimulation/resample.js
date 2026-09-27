// =============================================================================
//  resample.js — 引き直しエンジン(ブートストラップ・モンテカルロ)
// -----------------------------------------------------------------------------
//  何をする物か:
//    S1(simulate.js)の見立ては、各工程に「1つの見積り秒」を置いて完了時刻を1点で出す。
//    ここは同じ割当のまま、各ジョブの時間を **実測値の束から種付き乱数で引き直し**、
//    ロットの完了時刻の「幅」(P50/P80/P90 と、納期までに収まった回数)を出す。
//
//  どの決定に基づくか(2026-08-28 夜に清水さんが確定した事):
//    ・「間に合う」= 納期(dueDate)そのもの。日付だけの納期はその日の通常勤務終了
//      (現行の勤務表なら17:00)へ解決した dueMs を **呼ぶ側が渡す**(calendar.resolveDueAt)。
//    ・母集団の絞り込み(過去納期は基本無視・入荷登録付きは生かす・入荷が納期より後なら
//      「納期の更新が必要」のアラーム)は **この担当の外**。ここは渡された割当だけを扱う。
//    ・設備制約は今は見ない(将来モードON/OFFで追加予定)。
//
//  CONTRACT.md 0章の決め事(全部守る):
//    ・純関数のみ。React / Firebase を import しない。
//    ・関数の中で現在時刻や乱数を取らない。乱数は **種付きLCGを自作**(下の makeSeededRandom)。
//      同じ種なら毎回同じ結果(S23 と同じ決定性)。
//    ・数字には必ず出どころを構造で返す(どの実測を何件・どの段から借りたか)。
//    ・元データに無い値を推測で埋めない。出せない時は null と理由。
//
//  🚨 estimate.js の既存 export の挙動は変えない。ここは読むだけ
//    (percentile / taskDurationSec / ACCEPTED_QUALITY を再利用)。
// =============================================================================

// 🚨 工程の当て方は soloDependency.js の物を **そのまま** 使う(estimate.js と同じ約束)。
//    自前で当て直すと集計とキーがズレて、別工程の時間を掴む。
import { resolveTaskProcess, processKeyOf } from '../soloDependency.js';
// 🚨 実績の絞りは estimate.js と同条件(完了・duration>0・同じ品質判定)。
//    taskDurationSec はやり直し(reworks)込みの秒。ACCEPTED_QUALITY は 確定+推定。
import { taskDurationSec, ACCEPTED_QUALITY, percentile } from './estimate.js';
// 🚨 記録の質。低信頼(unreliable)・記録不足(missing)を束に混ぜない(仕様書6.5)。
import { taskTimeQualityOf } from '../taskTimeQuality.js';
// 時間の進め方は calendar.js の addDirectWorkMs ただ1本(CONTRACT.md「calendar.js」の節)。
// 勤務時間(休憩・定時・土日)を跨いだ実時刻はここでしか計算しない。
import { makeCalendar } from './calendar.js';
// 既定の1日の直接作業能力(420分)。数字を直書きしない(CONTRACT.md 7章 policy.js)。
import { DEFAULT_OPERATION_POLICY } from './policy.js';

// -----------------------------------------------------------------------------
// 0. 小道具と既定値
// -----------------------------------------------------------------------------
const str = (v) => (v == null ? '' : String(v));
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);

/** 各セルで使う「直近何件か」の既定。清水さんの指示(N=20を既定・値を結果に含める)。 */
export const DEFAULT_RECENT_N = 20;
/** 引き直しの回数の既定。 */
export const DEFAULT_DRAWS = 1000;
/**
 * 種の既定。⚠ 呼ぶ側が種を渡さなくても毎回同じ結果になる様に固定値
 * (「たまたま変わる」を作らない。値そのものに意味は無い)。
 */
export const DEFAULT_SEED = 20260828;

// -----------------------------------------------------------------------------
// 1. 種付き乱数(LCG)
// -----------------------------------------------------------------------------
/**
 * 種付きの線形合同法(LCG)。Numerical Recipes の定数(a=1664525, c=1013904223, m=2^32)。
 *
 * なぜ自作するか:
 *   CONTRACT.md 0章「関数の中で乱数を取らない」。Math.random は種を渡せないので
 *   同じ入力→同じ結果(S23)が守れない。LCGなら32bit整数演算だけで、どの環境でも同じ列が出る。
 *   ⚠ Math.imul で32bitに畳む。`*` だと53bitを超えた時に環境で違う丸めが起きる。
 *
 * @param {number} seed 有限の数。小数は切り捨てて32bitへ畳む
 * @returns {() => number} 呼ぶたびに [0,1) の次の値を返す関数
 */
export function makeSeededRandom(seed) {
  const s = Number(seed);
  if (!Number.isFinite(s)) {
    throw new Error('resample: seed は有限の数で渡してください(同じ種なら同じ結果になる決まりのため)');
  }
  let state = Math.floor(s) >>> 0;
  // 種が小さい数(0,1,2..)同士で最初の値が似るのを避けるため、1回から回しする。
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296; // 2^32。[0,1) に必ず収まる
  };
}

// -----------------------------------------------------------------------------
// 2. セルの鍵(4段の階段)
// -----------------------------------------------------------------------------
// 🚨 区切り文字を挟むだけの鍵にしない。先に長さを書く(soloDependency.processKeyOf と同じ理由。
//    `a|bc` と `ab|c` が同じ鍵になる事故を構造で塞ぐ)。
const lp = (v) => {
  const s = str(v);
  return `${s.length}:${s}`;
};

/** ① 本人×工程×型式。一番近い実測。 */
export const tier1KeyOf = (worker, processKey, model) => `1|${lp(worker)}|${lp(processKey)}|${lp(model)}`;
/** ② 本人×工程(型式は問わない)。 */
export const tier2KeyOf = (worker, processKey) => `2|${lp(worker)}|${lp(processKey)}`;
/** ③ 工程×型式の全員。 */
export const tier3KeyOf = (processKey, model) => `3|${lp(processKey)}|${lp(model)}`;
/** ④ 工程の全員。一番遠い借り方。 */
export const tier4KeyOf = (processKey) => `4|${lp(processKey)}`;

// -----------------------------------------------------------------------------
// 3. buildDurationSamples — 実測秒の束を作る
// -----------------------------------------------------------------------------
/**
 * タスク1件の「やった人の名前」。
 * sessions[].workerName と task.workerName から集める(soloDependency.attributeTask と同じ出所)。
 * ⚠ 名前がちょうど1人に決まる時だけ本人の段(①②)へ入れる。
 *   0人(誰か分からない)や2人以上(引き継ぎ)は、本人の束に入れると別人の時間が混ざるので
 *   全員の段(③④)にだけ入れる。捨てはしない(件数は diagnostics に残す)。
 */
const workerNamesOf = (task) => {
  const names = new Set();
  asArray(task && task.sessions).forEach((s) => {
    if (!isObj(s)) return;
    const n = str(s.workerName).trim();
    if (n) names.add(n);
  });
  const own = str(task && task.workerName).trim();
  if (own) names.add(own);
  return [...names];
};

/**
 * タスクの「いつやったか」。直近N件を選ぶための並べ替えに使う。
 * endTime → sessions の最後の endTime → firstStartTime/startTime の順
 * (taskTimeQuality.js / dailyWork.js と同じ優先順)。どれも無ければ null(一番古い扱い)。
 */
const taskAtMsOf = (task) => {
  const end = Number(task && task.endTime);
  if (Number.isFinite(end) && end > 0) return end;
  let sMax = null;
  asArray(task && task.sessions).forEach((s) => {
    const e = Number(s && s.endTime);
    if (Number.isFinite(e) && e > 0 && (sMax == null || e > sMax)) sMax = e;
  });
  if (sMax != null) return sMax;
  const first = Number(task && (task.firstStartTime || task.startTime));
  if (Number.isFinite(first) && first > 0) return first;
  return null;
};

/**
 * 完了タスクから「セル=(作業者名×工程キー×型式)ごとの実測秒の束」を作る。
 *
 * 実測の採り方は estimate.js の buildDurationStats と同じ絞り(挙動は変えず条件だけ揃える):
 *   ・status が acceptStatuses(既定 'completed')
 *   ・taskDurationSec > 0(やり直し込み。0以下や読めない物は数えない)
 *   ・記録の質が acceptedQuality(既定 確定+推定。低信頼・記録不足は捨てて件数を返す)
 *
 * 各セルでやる事(清水さんの指示):
 *   ・直近N件だけ使う(N=20が既定。使ったNは usedRecentN として結果に含める)
 *   ・「目標ピタリ」(実測 === その工程の目標秒)の件数を数え、直近N件の **過半** が
 *     ピタリならそのセルは幅の材料から外し、理由を返す。
 *     根拠: 最終検査で目標値のコピーが868件見つかった実測(2026-07-21)。
 *     コピーだらけの束から引くと「毎回ピタリ終わる」という嘘の幅(幅ゼロ)が出る。
 *     ⚠ ちょうど半分は外さない(過半=厳密に半分より多い時だけ)。
 *
 * @param {object} args
 * @param {Array} args.lots 全ロット(完了ロットも含める。履歴なので対象外にしない)
 * @param {string[]} [args.acceptStatuses] 既定 ['completed']
 * @param {string[]} [args.acceptedQuality] 既定 estimate.js の ACCEPTED_QUALITY(確定+推定)
 * @param {number} [args.recentN] 各セルで使う直近件数。既定 DEFAULT_RECENT_N(20)
 * @returns {{
 *   usedRecentN: number,
 *   tiers: {t1:Map, t2:Map, t3:Map, t4:Map},
 *   excludedPinned: Array<object>,
 *   diagnostics: object,
 * }}
 */
export function buildDurationSamples({
  lots,
  acceptStatuses = ['completed'],
  acceptedQuality = ACCEPTED_QUALITY,
  recentN = DEFAULT_RECENT_N,
} = {}) {
  const ok = new Set(asArray(acceptStatuses).map((v) => str(v).trim()).filter(Boolean));
  if (ok.size === 0) ok.add('completed');
  const okQ = new Set(asArray(acceptedQuality).map((v) => str(v).trim()).filter(Boolean));
  if (okQ.size === 0) ACCEPTED_QUALITY.forEach((q) => okQ.add(q));
  const nRecent = Number.isInteger(Number(recentN)) && Number(recentN) > 0
    ? Number(recentN) : DEFAULT_RECENT_N;

  const t1 = new Map();
  const t2 = new Map();
  const t3 = new Map();
  const t4 = new Map();

  const diagnostics = {
    lotsSeen: 0,
    tasksSeen: 0,
    tasksAccepted: 0,     // status が合った数
    tasksResolved: 0,     // 工程が決まった数
    tasksSampled: 0,      // 束へ入った数
    droppedNoDuration: 0, // 所要秒が読めない・0以下
    droppedByQuality: 0,  // 低信頼・記録不足で捨てた数(黙って捨てない)
    workerUnknownCount: 0, // 名前が1人に決まらず ①② に入れなかった数(③④には入れた)
  };

  /** 束へ1件積む。raw = {sec, atMs, pinned, order}。 */
  const push = (map, key, meta, raw) => {
    let cell = map.get(key);
    if (!cell) {
      cell = { key, ...meta, raw: [] };
      map.set(cell.key, cell);
    }
    cell.raw.push(raw);
  };

  let order = 0; // atMs が同じ・無い時の並びを入力順で安定させる(決定性)
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
        diagnostics.droppedNoDuration += 1;
        return;
      }
      const quality = str((taskTimeQualityOf(task) || {}).quality) || 'missing';
      if (!okQ.has(quality)) {
        diagnostics.droppedByQuality += 1;
        return;
      }
      diagnostics.tasksSampled += 1;

      const step = r.step || {};
      const processKey = processKeyOf(templateId, str(r.stepId));
      // 「目標ピタリ」= 実測がその工程の目標秒と完全一致。
      // ⚠ 目標はロットに焼かれた step.targetTime と比べる(そのタスクを打った時に画面に
      //   出ていた値。テンプレの現在値と比べると、後から目標を変えた工程で判定がズレる)。
      const target = Number(step.targetTime);
      const pinned = Number.isFinite(target) && target > 0 && sec === target;

      const names = workerNamesOf(task);
      const worker = names.length === 1 ? names[0] : null;
      if (worker == null) diagnostics.workerUnknownCount += 1;

      order += 1;
      const raw = { sec, atMs: taskAtMsOf(task), pinned, order };
      if (worker && model) push(t1, tier1KeyOf(worker, processKey, model), { tier: 1, worker, processKey, model }, raw);
      if (worker) push(t2, tier2KeyOf(worker, processKey), { tier: 2, worker, processKey, model: null }, raw);
      if (model) push(t3, tier3KeyOf(processKey, model), { tier: 3, worker: null, processKey, model }, raw);
      push(t4, tier4KeyOf(processKey), { tier: 4, worker: null, processKey, model: null }, raw);
    });
  });

  // 各セルを仕上げる: 直近N件に絞る → ピタリの過半で除外判定。
  const excludedPinned = [];
  for (const map of [t1, t2, t3, t4]) {
    for (const cell of map.values()) {
      // 古い→新しい の順。atMs 無し(null)は一番古い扱い。同時刻は入力順(決定性)。
      cell.raw.sort((a, b) => {
        const am = a.atMs == null ? -Infinity : a.atMs;
        const bm = b.atMs == null ? -Infinity : b.atMs;
        return (am - bm) || (a.order - b.order);
      });
      const recent = cell.raw.slice(-nRecent);
      cell.totalN = cell.raw.length;
      cell.samples = recent.map((x) => x.sec);
      cell.n = cell.samples.length;
      cell.pinnedCount = recent.reduce((a, x) => a + (x.pinned ? 1 : 0), 0);
      // 🚨 過半 = 厳密に半分より多い。半分ちょうどは外さない(実測が半分は残っているため)。
      cell.excluded = cell.pinnedCount * 2 > cell.n;
      cell.excludedReason = cell.excluded
        ? `直近${cell.n}件のうち${cell.pinnedCount}件が目標秒とピタリ同じ(過半)。目標のコピーの疑いがあり、幅の材料に使わない`
        : null;
      delete cell.raw; // 生の並びはもう使わない。結果を小さく保つ
      if (cell.excluded) {
        excludedPinned.push({
          tier: cell.tier,
          key: cell.key,
          worker: cell.worker,
          processKey: cell.processKey,
          model: cell.model,
          n: cell.n,
          pinnedCount: cell.pinnedCount,
          reason: cell.excludedReason,
        });
      }
    }
  }

  return { usedRecentN: nRecent, tiers: { t1, t2, t3, t4 }, excludedPinned, diagnostics };
}

// -----------------------------------------------------------------------------
// 4. lookupSamples — 借りる階段(①→②→③→④)
// -----------------------------------------------------------------------------
/**
 * (作業者名, 工程キー, 型式) に対して、使える実測の束を上の段から順に探す。
 *
 *   ① 本人×工程×型式  ② 本人×工程  ③ 工程×型式の全員  ④ 工程の全員
 *
 * ・どの段から借りたか(tier 1〜4)と件数を必ず返す。
 * ・ピタリ過半で外れたセルは飛ばして次の段へ落ちる(飛ばした事は excludedOnPath に残す)。
 * ・4段とも0件なら **null**(値を作らない。60秒などで埋めない — T030 と同じ考え)。
 *
 * @param {object} samplesIndex buildDurationSamples の戻り値
 * @param {object} coords {worker, processKey, model}
 * @param {object} [opts] {withTrace:true} なら外れた時も {tier:null, excludedOnPath} を返す
 * @returns {{tier:number, key:string, samples:number[], n:number, totalN:number,
 *            pinnedCount:number, excludedOnPath:object[]}|null}
 */
export function lookupSamples(samplesIndex, { worker, processKey, model } = {}, opts = {}) {
  if (!samplesIndex || !samplesIndex.tiers) return null;
  const w = str(worker).trim();
  const p = str(processKey);
  const m = str(model).trim();
  const { t1, t2, t3, t4 } = samplesIndex.tiers;

  const ladder = [];
  if (w && m) ladder.push({ map: t1, key: tier1KeyOf(w, p, m) });
  if (w) ladder.push({ map: t2, key: tier2KeyOf(w, p) });
  if (m) ladder.push({ map: t3, key: tier3KeyOf(p, m) });
  ladder.push({ map: t4, key: tier4KeyOf(p) });

  const excludedOnPath = [];
  for (const { map, key } of ladder) {
    const cell = map instanceof Map ? map.get(key) : null;
    if (!cell || cell.n === 0) continue;
    if (cell.excluded) {
      excludedOnPath.push({
        tier: cell.tier, key: cell.key, n: cell.n,
        pinnedCount: cell.pinnedCount, reason: cell.excludedReason,
      });
      continue;
    }
    return {
      tier: cell.tier,
      key: cell.key,
      samples: cell.samples,
      n: cell.n,
      totalN: cell.totalN,
      pinnedCount: cell.pinnedCount,
      excludedOnPath,
    };
  }
  // 4段とも材料なし。値を作らない。
  if (opts && opts.withTrace) return { tier: null, key: null, samples: null, n: 0, totalN: 0, pinnedCount: 0, excludedOnPath };
  return null;
}

// -----------------------------------------------------------------------------
// 5. resampleLotFinish — 引き直して完了時刻の分布を出す
// -----------------------------------------------------------------------------
/**
 * S1 の割当(作業者ごとのジョブ列)を入力に、各ジョブの時間だけ束から引き直して
 * 作業者ごとの時系列を積み直し、ロットの完了時刻の分布を出す。
 *
 * 🚨 これは近似である(結果にも approximation:'order-fixed' と明記する):
 *   ・割付(誰がやるか)と順番(その人の中の並び)は S1 のまま **変えない**。
 *   ・各ジョブの開始の下限は S1 の開始時刻(到着待ち・前工程待ちの門を作り直さない。
 *     前のジョブが引き直しで早く終わっても、S1で待っていた理由までは消えていないため)。
 *     前のジョブが長引いた分だけは後ろへ押す。
 *   ・相方付き(2人同時)の割当は主担当の列だけで積み直す(相方の列の玉突きまでは見ない)。
 *
 * 時間の進め方は calendar.addDirectWorkMs ただ1本(休憩・定時・土日を跨ぐ)。
 *
 * @param {object} args
 * @param {Array}  args.assignments S1の割当。1件 = {jobId, lotId, worker, startMs, endMs,
 *                 processKey?, model?, partner?}。processKey/model が無い物は jobMetaById で補える
 * @param {object} args.samplesIndex buildDurationSamples の戻り値
 * @param {number} args.dueMs 納期の実時刻(ms)。「間に合う」=これに収まる事
 *                 (清水さん決定 2026-08-28: 間に合う=納期そのもの。日付だけの納期は
 *                  resolveDueAt が17:00へ解決した値を渡す)。読めない時は onTime を出さない
 * @param {number} [args.draws] 引き直す回数。既定1000
 * @param {number} [args.seed] 乱数の種。同じ種なら同じ結果
 * @param {object} [args.calendar] makeCalendar の戻り値。省略時は通常420分の既定カレンダー
 * @param {string} [args.lotId] 分布を出すロット。省略時、割当のロットが1種ならそれ
 * @param {object|Map} [args.jobMetaById] jobId → {processKey, model} の補い
 * @returns {object} ok:true なら {p50,p80,p90(ms), onTime:{hit,draws}, provenance, ...}。
 *                   材料が足りない時は {ok:false, reason, ...}(数字は null。作らない)
 */
export function resampleLotFinish(args = {}) {
  const one = resampleLotsFinish({
    ...args,
    lotIds: [args.lotId == null ? null : str(args.lotId)],
  });
  const key = one.__soleKey;
  return one.byLot[key];
}

// -----------------------------------------------------------------------------
// 5b. resampleLotsFinish — 何本ものロットを **1回の引き直しで** まとめて出す
// -----------------------------------------------------------------------------
/**
 * 🚀 2026-08-30 性能是正。**答えは1つも変えない**。
 *
 * 【なぜ作ったか(実測)】
 *   本番の形(エミュレータへ写した実データ・5日・P75・範囲=手元＋14日)で段ごとに測ったら、
 *   全体 48.3秒のうち **引き直しが 44.2秒(91%)** だった。
 *   理由は呼び方にある: 上の resampleLotFinish は「1本のロット」を出すのに
 *   **全ロットの割当を丸ごと積み直す**。それをロットの数(上限120本)だけ繰り返していた。
 *     120本 × 1000回 × 全ジョブ ≒ 8千万回。
 *
 * 【なぜ同じ答えになるか(重要)】
 *   1回分の引き直しで積み上がる作業者ごとの時系列は、**どのロットを見ていても同じ**である:
 *     ・材料(どの束から引くか)は (作業者×工程×型式) だけで決まり、見ているロットに依らない。
 *       材料の無いジョブが「固定」になるのも同じ(自分のロットに材料が無ければ、
 *       そのロットは元から ok:false で数字を出さないので、成立する回の見え方は変わらない)。
 *     ・乱数の消費順(作業者名の昇順 × その人の中の順)も、割当が同じなら同じ。
 *     ・calendar の進め方も同じ。
 *   違うのは最後の1行、「どのジョブの終わりを拾って finish にするか」だけ。
 *   だから **積み直しは1回で足り**、ロットごとには終わりを拾い直すだけでよい。
 *
 * @param {object} args resampleLotFinish と同じ。ただし
 *   lotIds     … 分布を出したいロットIDの配列(null/空 の要素は「割当が1種なら自動」)
 *   dueMsByLot … lotId → 納期の実時刻(ms)。Map でもオブジェクトでも可。
 *                単一の dueMs を渡した時は、全ロットにそれを使う(単発の呼び出し用)
 * @returns {{byLot: Object<string, object>, __soleKey: string}}
 *   byLot は lotId → resampleLotFinish と**同じ形**の結果。
 */
export function resampleLotsFinish({
  assignments,
  samplesIndex,
  dueMs = undefined,
  dueMsByLot = null,
  draws = DEFAULT_DRAWS,
  seed = DEFAULT_SEED,
  calendar = null,
  lotIds = null,
  jobMetaById = null,
} = {}) {
  const nDraws = Number(draws);
  if (!Number.isInteger(nDraws) || nDraws < 1) {
    throw new Error('resample: draws は1以上の整数で渡してください(受け取った値: ' + JSON.stringify(draws) + ')');
  }
  // 種の検査は makeSeededRandom がやる(有限でなければ throw)。
  const cal = calendar || makeCalendar({
    directMinutesPerDay: DEFAULT_OPERATION_POLICY.regularDirectMinutesPerDay,
  });

  const usedRecentN = samplesIndex && Number.isFinite(Number(samplesIndex.usedRecentN))
    ? Number(samplesIndex.usedRecentN) : null;

  const wanted = Array.isArray(lotIds) && lotIds.length > 0
    ? lotIds.map((v) => (v == null ? null : str(v)))
    : [null];
  // 呼ぶ側が渡した鍵の見え方(null は '' として byLot に入れる)。
  const keyOf = (v) => (v == null ? '' : v);

  /** 1本ぶんの ok:false。上の resampleLotFinish が返していた物と同じ形。 */
  const failFor = (target, reason, notes, extra = {}) => ({
    ok: false,
    reason,
    approximation: 'order-fixed',
    lotId: target == null ? null : str(target),
    draws: nDraws,
    seed,
    p50: null, p80: null, p90: null,
    onTime: null,
    dueMs: null,
    s1FinishMs: null,
    provenance: {
      usedRecentN,
      tierCounts: { tier1: 0, tier2: 0, tier3: 0, tier4: 0, fixedNoMaterial: 0 },
      excludedPinned: [],
      jobs: [],
    },
    notes,
    ...extra,
  });

  /** 全部の要求に同じ失敗を返す(入力そのものが読めない時)。 */
  const failAll = (reason) => {
    const byLot = {};
    for (const t of wanted) byLot[keyOf(t)] = failFor(t, reason, []);
    return { byLot, __soleKey: keyOf(wanted[0]) };
  };

  const list = asArray(assignments);
  if (list.length === 0) return failAll('割当が0件。積み直す時系列が無い');

  const allLotIds = [...new Set(list.map((a) => str(a && a.lotId)))];

  // ── 割当の形の検査(壊れた入力で嘘の分布を出さない) ─────────────────────
  const metaOf = (a) => {
    if (jobMetaById instanceof Map) return jobMetaById.get(str(a.jobId)) || null;
    if (isObj(jobMetaById)) return jobMetaById[str(a.jobId)] || null;
    return null;
  };
  const jobs = [];
  for (const a of list) {
    if (!isObj(a)) return failAll('割当の中に読めない要素がある');
    const worker = str(a.worker).trim();
    const startMs = Number(a.startMs);
    const endMs = Number(a.endMs);
    if (!worker) return failAll(`割当 ${str(a.jobId)} に worker が無い`);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
      return failAll(`割当 ${str(a.jobId)} の startMs/endMs が読めない(または終わりが始まりより前)`);
    }
    const meta = metaOf(a) || {};
    jobs.push({
      jobId: str(a.jobId),
      lotId: str(a.lotId),
      worker,
      startMs,
      endMs,
      processKey: str(a.processKey || meta.processKey),
      model: str(a.model || meta.model),
      partner: a.partner == null ? null : str(a.partner),
    });
  }
  const hasPartner = jobs.some((j) => j.partner);
  const PARTNER_NOTE = '相方付きの割当がある。相方の列の玉突きまでは積み直していない(主担当の列だけの近似)';

  // ── 各ジョブの材料(実測の束)を決める ──────────────────────────────────
  //   材料が無いジョブは、時系列の前後関係のために S1 の所要(勤務時間で測り直した実働ms)を
  //   固定で使う。⚠ 実測からの引き直しではない事は tierCounts.fixedNoMaterial が示す。
  //   そのジョブが「見ているロット自身」の物だった時だけ、そのロットは数字を出せない。
  const tierCountsShared = { tier1: 0, tier2: 0, tier3: 0, tier4: 0, fixedNoMaterial: 0 };
  const excludedPinnedMap = new Map(); // key → 除外セル(重複を1つに)
  const provenanceJobs = [];           // 🚨 成立した回の中身は全ロット共通(理由は上の説明)
  const noMaterialByLot = new Map();   // lotId → 材料の無かったジョブ
  const provIndexOf = new Map();       // jobId → provenanceJobs の位置(失敗の回だけ作り替える)
  for (const j of jobs) {
    const hit = lookupSamples(samplesIndex, { worker: j.worker, processKey: j.processKey, model: j.model }, { withTrace: true });
    const trace = hit && hit.excludedOnPath ? hit.excludedOnPath : [];
    trace.forEach((x) => { if (!excludedPinnedMap.has(x.key)) excludedPinnedMap.set(x.key, x); });
    if (hit && hit.tier != null) {
      // 束の中身の検査。壊れた値(0以下・非数)が混ざった束から引くと分布ごと嘘になる。
      if (!Array.isArray(hit.samples) || hit.samples.length === 0
        || hit.samples.some((s) => !Number.isFinite(Number(s)) || Number(s) <= 0)) {
        return failAll(`ジョブ ${j.jobId} の束(${hit.key})に読めない実測が混ざっている`);
      }
      j.material = { kind: 'samples', tier: hit.tier, key: hit.key, samples: hit.samples, n: hit.n };
      tierCountsShared[`tier${hit.tier}`] += 1;
      provIndexOf.set(j.jobId, provenanceJobs.length);
      provenanceJobs.push({
        jobId: j.jobId, lotId: j.lotId, worker: j.worker,
        tier: hit.tier, cellKey: hit.key, n: hit.n, totalN: hit.totalN,
      });
    } else {
      const fixedMs = cal.workMsBetween(j.startMs, j.endMs, j.worker);
      j.material = { kind: 'fixed', tier: null, key: null, fixedMs };
      tierCountsShared.fixedNoMaterial += 1;
      let arr = noMaterialByLot.get(j.lotId);
      if (!arr) { arr = []; noMaterialByLot.set(j.lotId, arr); }
      arr.push(j);
      provIndexOf.set(j.jobId, provenanceJobs.length);
      provenanceJobs.push({
        jobId: j.jobId, lotId: j.lotId, worker: j.worker,
        tier: null, cellKey: null, n: 0, totalN: 0, fixedMs,
      });
    }
  }
  const excludedPinnedShared = [...excludedPinnedMap.values()];

  // ── どのロットを出すか決める ──────────────────────────────────────────
  const targets = [];           // 実際に積み直す対象(材料の足りた物だけ)
  const results = {};           // lotId(呼ぶ側の鍵) → 結果
  for (const req of wanted) {
    const key = keyOf(req);
    let target = req;
    if (target == null || target === '') {
      if (allLotIds.length === 1) {
        target = allLotIds[0];
      } else {
        // ⚠ ここは1本ずつ計算していた頃と同じく、相方の但し書きはまだ付かない
        //   (割当の中身を見る前に決まる失敗なので)。
        results[key] = failFor(req, `割当に${allLotIds.length}種のロットが混ざっている。どのロットの分布を出すか lotId で指定する事`, []);
        continue;
      }
    }
    if (!allLotIds.includes(target)) {
      results[key] = failFor(req, `指定の lotId(${target}) が割当の中に無い`, []);
      continue;
    }
    const miss = noMaterialByLot.get(target) || [];
    if (miss.length > 0) {
      // 🚨 このロットの分は元から出せない。理由と、どのジョブが足りないかを返す。
      const who = miss.map((j) => `${j.jobId}(${j.worker}×${j.processKey}×${j.model || '型式なし'})`).join('、');
      // 自分のロットの材料無しは「固定で置いた物」として数えない(1本ずつ計算していた頃と同じ)。
      const tc = { ...tierCountsShared, fixedNoMaterial: tierCountsShared.fixedNoMaterial - miss.length };
      const jobsOut = provenanceJobs.slice();
      for (const j of miss) {
        const at = provIndexOf.get(j.jobId);
        if (at != null) {
          jobsOut[at] = { jobId: j.jobId, lotId: j.lotId, worker: j.worker, tier: null, cellKey: null, n: 0, totalN: 0 };
        }
      }
      results[key] = failFor(
        req,
        `引き直しの材料が足りない。対象ロットの${miss.length}件は4段(本人×工程×型式→本人×工程→工程×型式の全員→工程の全員)とも実測0件: ${who}`,
        hasPartner ? [PARTNER_NOTE] : [],
        { provenance: { usedRecentN, tierCounts: tc, excludedPinned: excludedPinnedShared, jobs: jobsOut } },
      );
      continue;
    }
    targets.push({ key, target });
  }

  if (targets.length > 0) {
    // ── 作業者ごとの列(順序固定)を作る ──────────────────────────────────
    const byWorker = new Map();
    for (const j of jobs) {
      let arr = byWorker.get(j.worker);
      if (!arr) { arr = []; byWorker.set(j.worker, arr); }
      arr.push(j);
    }
    // 🚨 反復順を決め打ちにする(乱数の消費順が変わると同じ種でも結果が変わるため)。
    const workerNames = [...byWorker.keys()].sort();
    for (const w of workerNames) {
      byWorker.get(w).sort((a, b) => (a.startMs - b.startMs) || (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0));
    }
    const chains = workerNames.map((w) => ({ w, list: byWorker.get(w) }));

    // 対象ロットの置き場。ジョブ1件ずつに「どの対象の入れ物へ入れるか」を先に貼る。
    const slotOf = new Map();   // lotId → 何番目の対象か
    targets.forEach((t, i) => { slotOf.set(t.target, i); });
    for (const j of jobs) {
      const s = slotOf.get(j.lotId);
      j.slot = (s === undefined) ? -1 : s;
    }
    const finishes = targets.map(() => new Array(nDraws).fill(null));

    // ── 引き直し本体(**1回だけ**。ロットの数だけ繰り返さない) ─────────────
    const rng = makeSeededRandom(seed);
    for (let d = 0; d < nDraws; d++) {
      for (const chain of chains) {
        const w = chain.w;
        let cursor = null; // その人の直前のジョブの終わり
        for (const j of chain.list) {
          // 開始 = max(直前の終わり, S1の開始)。そこから「次に働ける時刻」へ寄せる。
          const floor = cursor == null ? j.startMs : (cursor > j.startMs ? cursor : j.startMs);
          const start = cal.addDirectWorkMs(floor, 0, w);
          let durMs;
          if (j.material.kind === 'samples') {
            const idx = Math.floor(rng() * j.material.n);
            durMs = j.material.samples[idx] * 1000;
          } else {
            durMs = j.material.fixedMs;
          }
          const end = cal.addDirectWorkMs(start, durMs, w);
          cursor = end;
          if (j.slot >= 0) {
            const cur = finishes[j.slot][d];
            if (cur == null || end > cur) finishes[j.slot][d] = end;
          }
        }
      }
    }

    // ── 集計 ───────────────────────────────────────────────────────────
    for (let i = 0; i < targets.length; i++) {
      const { key, target } = targets[i];
      const notes = hasPartner ? [PARTNER_NOTE] : [];
      const arr = finishes[i];
      // 分位点は estimate.js の percentile(線形補間)を再利用。定義を2つ作らない。
      const p50 = Math.round(percentile(arr, 0.5));
      const p80 = Math.round(percentile(arr, 0.8));
      const p90 = Math.round(percentile(arr, 0.9));

      let s1FinishMs = null;
      for (const j of jobs) {
        if (j.lotId === target && (s1FinishMs == null || j.endMs > s1FinishMs)) s1FinishMs = j.endMs;
      }

      let due = Number(dueMs);
      if (dueMsByLot instanceof Map) due = Number(dueMsByLot.get(target));
      else if (isObj(dueMsByLot)) due = Number(dueMsByLot[target]);
      let onTime = null;
      let dueOut = null;
      if (Number.isFinite(due)) {
        let hit = 0;
        for (const f of arr) { if (f <= due) hit += 1; }
        onTime = { hit, draws: nDraws };
        dueOut = due;
      } else {
        notes.push('dueMs が読めないので onTime(納期までに収まった回数)は出していない');
      }

      results[key] = {
        ok: true,
        approximation: 'order-fixed', // 🚨 割付・順番はS1のまま。時間だけ引き直した近似
        lotId: target,
        draws: nDraws,
        seed,
        p50, p80, p90,
        s1FinishMs,
        onTime,
        dueMs: dueOut,
        provenance: {
          usedRecentN,
          tierCounts: tierCountsShared,
          excludedPinned: excludedPinnedShared,
          // 🚨 中身は全ロット共通なので入れ物も共有する(別スレッドへ写す量が
          //    ロットの本数ぶん膨らむのを防ぐ。値は1つも変わらない)。
          jobs: provenanceJobs,
        },
        notes,
      };
    }
  }

  // 🚨 並び順も、1本ずつ回していた頃と同じ(頼まれた順)にして返す。
  //   値が同じでも入れ物の並びが変わると、画面が「先頭から何件」を出す所で見え方が変わる。
  const ordered = {};
  for (const req of wanted) {
    const k = keyOf(req);
    if (Object.prototype.hasOwnProperty.call(results, k)) ordered[k] = results[k];
  }
  return { byLot: ordered, __soleKey: keyOf(wanted[0]) };
}
