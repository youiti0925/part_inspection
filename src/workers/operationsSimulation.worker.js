// =============================================================================
//  operationsSimulation.worker.js — 操業シミュレーションを別スレッドで回す入れ物
// -----------------------------------------------------------------------------
//  出典: Claude是正指示_実績監査ではなく操業シミュレーターを作る.md 8.2 /
//        src/domain/operationsSimulation/CONTRACT.md
//
//  🚨 ここは **計算の入れ物** であって、計算そのものではない。
//     式・しきい値・工程の順番は src/domain/operationsSimulation/ の完成済みの
//     モジュールが持っている。ここへ式を書き足さない（2か所で同じ事を決めない）。
//
//  🚨 setTimeout(...,0) は「別スレッド化」ではない（指示書2.3）。
//     このファイルの計算が画面と別で動くのは **Worker だから** であって、
//     下の yieldToHost() のせいではない。yieldToHost() の役目はただ1つ、
//     「区切りで一度だけ、届いているメッセージ（中止・新しい依頼）を受け取らせる」事。
//
//  【本番の実測 2026-08-22】手元10件=111ms / 179件=約5秒 / 282件=約8秒。
//     無言で8秒待たせないので、区切りごとに進み具合を送る。
//     ⚠ 進み具合の割合は **区切りの重み** から出した目安であって、残り時間の予測ではない。
//     ⚠ 1本のシミュレーションが走っている最中は途中経過を出せない
//        （エンジン側に「何%進んだ」を知らせる仕組みが無い）。細かく見せるために
//        エンジンへ刻みを足す事はしない（完成済みなので触らない）。
//
// -----------------------------------------------------------------------------
//  【受け取るメッセージ】
//    { kind:'run', runId, lots, templates, workers, settings, now,
//      horizonDays, scenario, mode, scopeLotIds, dataKey,
//      runSkillTrials, maxSkillTrials }
//        ・runSkillTrials … 🚨 **押した時だけ true**（決まり19B の材料①）。
//          スキルを仮に付けて割付を引き直す。1件が本物の割付1回なので、
//          実測で1件約3.0秒（本番の写し249ロット・5営業日）。既定 false。
//        ・maxSkillTrials … 何件まで引き直すか。既定4（1人1件・最大4件）。
//        ・kind を省いた物も 'run' として扱う。
//        ・scopeLotIds … 実際にシミュレーションへ載せるロットIDの一覧。
//          🚨 lots は **全部** 渡してもらう。過去の作業記録（完了ロット）が無いと
//             「誰がこの工程をやった記録があるか」が数えられず、
//             全員「記録がありません」になって嘘の結論が出る。
//             未来へ流すロットだけを scopeLotIds で絞る。null なら絞らない。
//        ・dataKey … lots/templates/workers/settings の指紋。同じなら過去の記録の
//          集計（重い）と正規化を作り直さない（指示書8.2「同じ入力で再計算する時は
//          正規化結果を再利用する」）。
//    { kind:'abort', runId }   … 中止。runId 省略なら走っている物を中止。
//
//  【送り返すメッセージ】
//    { kind:'ready' }                                        … 起動できた合図
//    { runId, kind:'progress', phase, label, ratio }         … 進み具合
//    { runId, kind:'result', ok:true,  result:{...}, elapsedMs }
//    { runId, kind:'result', ok:false, error:'日本語1行' }
//    { runId, kind:'aborted', reason }                       … 中止した / 新しい依頼に譲った
//
//  【中止の効き方（正直に書く）】
//    Worker は1本の計算を回している間、メッセージを受け取れない。
//    よって中止が効くのは **区切りの切れ目** （下の PHASE の間）。
//    区切りの中で一番長いのはシミュレーション本体なので、押してすぐ止まる訳ではない。
// =============================================================================

import { computeSoloDependency, docIdOf } from '../domain/soloDependency.js';
import { normalizeInput } from '../domain/operationsSimulation/normalizeInput.js';
// 🎲 実測の引き直し(S2 2026-08-28)。割付はS1の1本のまま、時間だけ実測の束から引き直す
import { buildDurationSamples, resampleLotsFinish, DEFAULT_SEED as RESAMPLE_SEED } from '../domain/operationsSimulation/resample.js';
import { makeCalendar, buildSnapshotTargets } from '../domain/operationsSimulation/calendar.js';
import { buildEligibility, MODE_ALL, DEFAULT_MODE } from '../domain/operationsSimulation/historyEligibility.js';
import { buildSkillConfig } from '../domain/skillRegistry.js';
// 🚨 確定実績から工数を見積もる(仕様書5.6 / F1)。**全ロット**から集める。
import { skipHistoryOf } from '../domain/operationsSimulation/skipHistory.js';
import { buildDurationStats, DEFAULT_ESTIMATE_MODE } from '../domain/operationsSimulation/estimate.js';
// 🚨 シナリオ比較の「同じ土俵」と非悪化保証と原因分類(仕様書5.8/5.9/5.10 / F1)。
//   画面がここを呼ぶと重い計算を2回する事になるので、**Worker の中で1回だけ**作って返す。
import {
  toScenarioMetrics, resolveAllSkills, classifyCauses, SCENARIO_ID,
} from '../domain/operationsSimulation/scenarios.js';
// 🚨 F3 教育提案（読み取り専用）。将来どの工程で人が足りなくなるか → OJT候補。
//   ⚠ **力量マスタへは1バイトも書かない**（見張り S24 / H07-3）。
import {
  buildProcessDemand, buildProcessSupply, findShortfalls, buildPeriods, freeMinutesByWorkerOf,
  buildMonthPeriods,
} from '../domain/operationsSimulation/forecast.js';
// 📅 月ごと(2026-09-03 清水さん「一月毎に、月毎の必要な人材を確認する」)。
//   🚨 計算は monthly.js（完成済み）を呼ぶだけ。ここに足し算を書かない。
import {
  demandByMonth, capacityByMonth, buildMonthlyOutlook, buildWeeklyBreakdown, demandByLot,
} from '../domain/operationsSimulation/monthly.js';
// 🚨 「到着待ちに置かれたまま作業の記録0件」の山。数える／数えないの両方を出す為に要る。
import { buildArrivalExplainIndex, buildUntouchedPile } from '../domain/operationsSimulation/untouchedPile.js';
import { isOpenLot } from '../domain/dueDefense.js';
import {
  findFutureShortfalls, buildOjtCandidates, buildOjtScenario, buildStudyCandidates,
} from '../domain/operationsSimulation/education.js';
// 🎯 決まり19B の材料①「スキルを仮に付けて引き直す」(2026-09-04 配線)。
//   ⚠ 純関数は decisionBoard.js が持っている。ここは **引き直しを回して渡すだけ**。
import { buildSkillTrialCandidates, compareSkillTrial } from '../domain/operationsSimulation/decisionBoard.js';
// 🎓 決まり19B の材料②「教えるのに要る営業日」(2026-09-04 配線)。
//   🚨 材料が無い工程は **出ないとそのまま返す**。0日で埋めない(2026-08-20)。
import { buildEducationLeadTime } from '../domain/operationsSimulation/educationLeadTime.js';
import { simulateOperations } from '../domain/operationsSimulation/simulate.js';
// 🕒 納期対応の残業・土曜(必要分)。貪欲法は純関数(overtimePlan.js)。ここは runOnce を組んで回すだけ。
import { planOvertimeAsNeeded, ymdOfMs } from '../domain/operationsSimulation/overtimePlan.js';
//   土曜かどうかは workerAvailability.weekdayOfYmd(曜日の読み方は1本)。稼働日そのものは calendar.isWorkday(工場の暦)で決める。
import { weekdayOfYmd } from '../domain/operationsSimulation/workerAvailability.js';
const SATURDAY = 6;
import { explainResult } from '../domain/operationsSimulation/explain.js';

// -----------------------------------------------------------------------------
// 区切り（進み具合の見出し）
// -----------------------------------------------------------------------------
// 🚨 出してはいけない言葉（PANEL_SPEC.md 7章 / CONTRACT.md 0章 の一覧）を入れない。
export const PHASE_LABEL = Object.freeze({
  history: '過去の作業記録から、担当できる人を数えています',
  normalize: 'ロットを、仕事の形に直しています',
  simulate: '時間を進めて、人を仕事へ当てています',
  // 🚨 2026-08-30 追記: 引き直しと教育の見出しが抜けていた。抜けていると
  //   進み具合の分母(下の PHASE_WEIGHT)にも入らず、この2つを終えた時点で
  //   割合が NaN になり、棒が0%へ戻って見えていた。
  resample: '実測の幅で、終わり方を引き直しています',
  allSkills: '全員がどの工程も持てる仮定で、もう一度進めています',
  explain: '遅れの原因と、効く手を分けています',
  education: '将来どの工程で人が足りなくなるかを見ています',
  monthly: '月ごとに、人が足りるかを見ています',
  // 🚨 押した時だけ回す段(決まり19B)。既定では走らないので、進み具合の分母にも入れない。
  skillTrials: 'スキルを仮に付けて、割付を引き直しています',
  done: '計算が終わりました',
});

// 区切りの重み。実測（282件で約8秒）の内訳から、時間を食う順に置いた **目安**。
// ⚠ 端末とデータで変わる。ここは進み具合の棒の伸び方を決めるだけで、判定には一切使わない。
// ⚠ 2026-08-30 実測(本番の形・5日・P75)で置き直した目安。
//   引き直しを速くする前は 全体48.3秒のうち引き直しが44.2秒(91%)だった。速くした後の
//   内訳は 通常の割付 > 全員万能 > 引き直し。**判定には一切使わない**(棒の伸び方だけ)。
const PHASE_WEIGHT = Object.freeze({
  history: 8,
  normalize: 6,
  simulate: 40,
  resample: 12,
  allSkills: 30,
  explain: 3,
  education: 2,
  monthly: 2,
  // ⚠ 押した時だけ。order に入るのは runSkillTrials:true の時だけ。
  skillTrials: 30,
});

/** 盤面のカードを動かすための写真の間隔。渡されなければ2時間ごと。 */
export const DEFAULT_SNAPSHOT_MS = 2 * 60 * 60 * 1000;

/** 既定の見通し日数。指示書5「5日操業シミュレーター」。 */
export const DEFAULT_HORIZON_DAYS = 5;

// -----------------------------------------------------------------------------
// 小さい道具
// -----------------------------------------------------------------------------
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : []);
const str = (v) => (v == null ? '' : String(v));
const round2 = (n) => Math.round(n * 100) / 100;
const noop = () => {};

/** 経過時間。performance が無い端末でも動くようにしておく。 */
function nowStamp() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * 中止の合図。
 * エンジンが見るのは `signal.aborted` の1つだけなので、AbortController が無い端末
 * （古い iPad Safari）でも同じ形の物を自前で作って渡す。
 */
export function makeAbortToken() {
  if (typeof AbortController === 'function') {
    const ctrl = new AbortController();
    return { signal: ctrl.signal, abort: () => ctrl.abort() };
  }
  const signal = { aborted: false };
  return { signal, abort: () => { signal.aborted = true; } };
}

function abortError(reason) {
  const err = new Error(reason || '計算を中止しました');
  err.opsimAborted = true;
  return err;
}

/**
 * エラーを **日本語の1行** にする。握り潰さない。
 * エンジン側のメッセージは既に日本語なので、そのまま後ろへ付ける。
 */
export function oneLineError(err) {
  const raw = (err && err.message) ? String(err.message) : str(err);
  const one = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  return one
    ? `操業シミュレーションの計算が最後まで進みませんでした: ${one}`
    : '操業シミュレーションの計算が最後まで進みませんでした（理由が取れませんでした）';
}

/**
 * 使い回しの鍵にする、並び順の決まった文字列。
 * ⚠ JSON.stringify はキーの入った順で並ぶので、同じ中身でも別の文字列になる事がある。
 *   鍵がずれても「作り直す」だけで結果は変わらないが、無駄が出るのでキーを並べ替える。
 */
export function stableKey(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'function') return '"fn"';
  return JSON.stringify(value);
}

// -----------------------------------------------------------------------------
// 計算の本体（Worker からも、Worker が作れない端末のやり直し用からも、同じ物を呼ぶ）
// -----------------------------------------------------------------------------
/**
 * @param {object} payload 上の「受け取るメッセージ」と同じ形
 * @param {object} [opts]
 *   signal      … { aborted:boolean }。エンジンへそのまま渡す
 *   onProgress  … (phase, label, ratio) => void
 *   yieldToHost … () => Promise。区切りで一度だけ制御を返す
 *   cache       … 使い回し置き場（同じ入力で作り直さないため）。呼ぶ側が持つ
 *   isCurrent   … () => boolean。false になったら捨ててよい（新しい依頼が来た）
 * @returns {Promise<{base:object, allSkills:object|null, explain:object, normalized:object, meta:object}>}
 */
export async function runOperationsSimulationPipeline(payload, opts = {}) {
  const p = isObj(payload) ? payload : {};
  const o = isObj(opts) ? opts : {};
  const signal = isObj(o.signal) ? o.signal : { aborted: false };
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : noop;
  const yieldToHost = typeof o.yieldToHost === 'function' ? o.yieldToHost : (() => Promise.resolve());
  const cache = isObj(o.cache) ? o.cache : {};
  const isCurrent = typeof o.isCurrent === 'function' ? o.isCurrent : (() => true);

  const lots = asArray(p.lots);
  const templates = asArray(p.templates);
  const workers = asArray(p.workers);
  const settings = isObj(p.settings) ? p.settings : {};

  const now = Number(p.now);
  if (!Number.isFinite(now)) {
    // 🚨 ここで Date.now() に落とすと「同じ入力→同じ結果」(S23) が壊れる。黙って補わない。
    throw new Error('今の時刻(now)が渡っていません。呼ぶ側で1回だけ決めて渡してください');
  }

  const hd = Math.trunc(Number(p.horizonDays));
  const horizonDays = (Number.isFinite(hd) && hd > 0) ? hd : DEFAULT_HORIZON_DAYS;

  const scenarioIn = isObj(p.scenario) ? p.scenario : {};
  const mode = (p.mode === undefined || p.mode === null) ? DEFAULT_MODE : p.mode;
  // 見積りモード(P50 通常線 / P75 保険線 / P90 絶対線)。既定は P75。
  // ⚠ モードが違う結果どうしは比べない(指紋に入る)。画面の切替は F2 で配線する。
  const estMode = (p.estimateMode === 'P50' || p.estimateMode === 'P75' || p.estimateMode === 'P90')
    ? p.estimateMode : DEFAULT_ESTIMATE_MODE;
  // どのシナリオとして回したか。画面が「通常との差」を出す時の札になる。
  const scopeLotIds = Array.isArray(p.scopeLotIds) ? p.scopeLotIds.map(str).filter(Boolean) : null;
  const dataKey = str(p.dataKey);

  // 🚨 これを渡さないと snapshots が0件になり、盤面のカードが1ミリも動かない。
  const snapEvery = Number(scenarioIn.snapshotEveryMs);
  const snapshotEveryMs = (Number.isFinite(snapEvery) && snapEvery > 0) ? Math.round(snapEvery) : DEFAULT_SNAPSHOT_MS;

  // 「全員がどの工程も持てる仮定」との比べ物。これが無いと
  // 「仕事量が多すぎる」のか「担当できる人が偏っている」のかを分けられない（指示書4/5.7）。
  const compareAllSkills = scenarioIn.compareAllSkills !== false;

  // ── 区切りの進み具合 ──────────────────────────────────────────────────────
  // 🚨 決まり19B の材料①(スキルを仮に付けて引き直す)は **押した時だけ**。
  //   実測: 1回の引き直しが約3.0秒(本番の写し249ロット・5営業日)。4件で約12秒。
  //   毎回足すと、いまの合計 約5.3秒 が 約17秒 になります。だから既定は false。
  const runSkillTrials = p.runSkillTrials === true;
  const maxSkillTrials = (() => {
    const n = Math.trunc(Number(p.maxSkillTrials));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 8) : 4;   // 1人1件・最大4件(decisionBoard.js の仕様)
  })();
  const order = ['history', 'normalize', 'simulate', 'resample'];
  if (compareAllSkills) order.push('allSkills');
  order.push('explain', 'education', 'monthly');
  if (runSkillTrials) order.push('skillTrials');
  const totalWeight = order.reduce((a, k) => a + PHASE_WEIGHT[k], 0);

  let doneWeight = 0;
  const phaseMs = {};
  let phaseStartedAt = 0;

  const guard = async () => {
    // ⚠ ここで一度だけ制御を返す。Worker では「届いている中止/新しい依頼を受け取る」ため、
    //   やり直し用（メインスレッド）では「画面に進み具合を描き直させる」ため。
    //   🚨 どちらの場合も、計算が別スレッドへ移る訳ではない。
    await yieldToHost();
    if (signal.aborted) throw abortError();
    if (!isCurrent()) throw abortError('新しい依頼が来たので、前の計算をやめました');
  };

  const begin = async (key) => {
    await guard();
    phaseStartedAt = nowStamp();
    onProgress(key, PHASE_LABEL[key], round2(doneWeight / totalWeight));
  };
  const end = (key) => {
    phaseMs[key] = Math.round(nowStamp() - phaseStartedAt);
    doneWeight += PHASE_WEIGHT[key];
  };

  // ── ① 過去の作業記録 → 担当できる人 ───────────────────────────────────────
  await begin('history');
  let solo;
  let historyFromCache = false;
  if (dataKey && cache.dataKey === dataKey && isObj(cache.solo)) {
    solo = cache.solo;
    historyFromCache = true;
  } else {
    // 🚨 ここへ渡すのは **全ロット**。完了ロットを外すと「やった記録」が消える。
    solo = computeSoloDependency({ lots, templates, workers });
    if (dataKey) {
      cache.dataKey = dataKey;
      cache.solo = solo;
      cache.durationStats = null;   // ⚠ 入力が変わったら実績の統計も作り直す
      cache.skipHistory = null;     // ⚠ 飛ばす工程の数えも同じ
      cache.durationSamples = null; // ⚠ 引き直しの束も同じ(入力が変われば作り直す)
      cache.normKey = null;
      cache.normalized = null;
    }
  }
  // スキルの登録（settings.workerSkills × templates.requiredSkills）。
  //   🚨 式は skillRegistry.buildSkillConfig ただ1つ（OperationsSimulationPanel.jsx と同じ物）。登録0件なら null（止めない＝指示書4）。
  const skillConfig = buildSkillConfig({ settings, templates });
  const eligibility = buildEligibility({ soloResult: solo, workers, skillConfig, mode, scenario: scenarioIn });

  // 🚨 確定実績の統計(P50/P75/P90 の素)。**ここも全ロット**から作る。
  //   下の normalizeInput へ渡すのは範囲で絞った lots なので、
  //   あちらで集めると標本が消える(完了ロットが範囲外に落ちる)。
  //   solo と同じ dataKey で使い回す(同じ入力なら作り直さない)。
  let durationStats;
  if (dataKey && cache.dataKey === dataKey && isObj(cache.durationStats)) {
    durationStats = cache.durationStats;
  } else {
    durationStats = buildDurationStats({ lots });
    if (dataKey) cache.durationStats = durationStats;
  }
  // 🚫 記録でほぼ毎回飛ばす工程(2026-09-18 清水さん「該当なしなんでしょ…飛ばしてやるだけでしょ？」)。
  //   **全ロット** から数える(範囲で絞った lots では記録が消える)。solo と同じ dataKey で使い回す。
  //   🚨 数えるだけ。積まないのは normalizeInput(alwaysSkippedProcessKeys)。積む側へ戻す口は scenario.countAlwaysSkipped。
  let skipHistory;
  if (dataKey && cache.dataKey === dataKey && isObj(cache.skipHistory)) {
    skipHistory = cache.skipHistory;
  } else {
    skipHistory = skipHistoryOf({ lots, templates });
    if (dataKey) cache.skipHistory = skipHistory;
  }
  end('history');

  // ── ② 正規化 ─────────────────────────────────────────────────────────────
  await begin('normalize');
  const scopeSet = scopeLotIds ? new Set(scopeLotIds) : null;
  const scopedLots = scopeSet ? lots.filter((l) => scopeSet.has(docIdOf(l))) : lots;

  /**
   * 📅 工場の暦(祝日・全社休業・休日出勤)。**dataKey には入っていない。**
   *
   * なぜ別に足すか(2026-09-07 実測):
   *   dataKey を作るのは画面側の fingerprintData で、材料は **生の settings**。
   *   ところが暦は settings ではなく共通の棚から別の口で来て、
   *   payload を組む所(useOperationsSimulation)で settings へ混ぜている。
   *   だから「暦だけを変えた」時、dataKey は1文字も変わらない。
   *   ここへ足さないと下の使い回しが当たり、**祝日を登録しても効かない計算** になる。
   *
   *   実測(2026-09-07・JST・作り物の1人1ロットで測った値。本番の数字ではない):
   *   同じ dataKey・同じ now(9/7 08:30)・5営業日で 9/8 を休みにすると、
   *   空の使い回し置き場なら horizonEnd が 9/14 08:30 → 9/15 08:30 へ1日ずれるのに、
   *   前の答えが残っている置き場では 9/14 08:30 のまま1ミリも動かず、
   *   数えた休みも 0件 のままだった。
   *
   * ⚠ 暦をシナリオで差し替える道(normalizeInput の sc.factoryCalendar)は
   *   すぐ上の stableKey(scenarioIn) が既に見ているので、二重には足さない。
   *   その事は worker-normalize-cache-calendar.test.mjs の T4 が押さえている。
   */
  const factoryCalendarKey = stableKey(settings.factoryCalendar);
  const normKey = dataKey
    ? [dataKey, now, horizonDays, stableKey(scenarioIn), scopeLotIds ? scopeLotIds.join(',') : 'all',
      estMode, factoryCalendarKey].join('|')
    : '';
  let normalized;
  let normalizeFromCache = false;
  if (normKey && cache.normKey === normKey && isObj(cache.normalized)) {
    normalized = cache.normalized;
    normalizeFromCache = true;
  } else {
    normalized = normalizeInput({
      lots: scopedLots, templates, workers, settings, now, horizonDays, scenario: scenarioIn,
      durationStats, estimateMode: estMode,
      alwaysSkippedProcessKeys: skipHistory.keys,
    });
    // 画面が帯に出す為に、数えた行(テンプレ×工程×件数)も答えに添える(normalizeInput の外の情報。数はここで作らない)。
    normalized.inputQuality.alwaysSkippedRows = skipHistory.rows;
    if (normKey) {
      cache.normKey = normKey;
      cache.normalized = normalized;
    }
  }
  const calendar = makeCalendar(normalized.calendarSpec);
  end('normalize');

  // ── ③ 時間を進める ───────────────────────────────────────────────────────
  await begin('simulate');
  // 🚨 画面の記録は **要求した時刻だけ** 撮る（2026-08-23 の是正）。
  //   粗い目盛り: 5日=0.3日ごと18枚 / 30日=1日ごと31枚（buildSnapshotTargets）。
  //   以前は実時間30分ごと(夜も土日も)で 5日337枚(23MB)・30日は600枚上限で12.5日で打ち切りだった。
  //
  // 🚨🚨 2026-09-04 決まり15（清水さん「作業者が処理してるのに残り時間が変わってなかったり」）の根:
  //   5日の記録が 0.3日(=直接作業126分)ごと **しか無かった**。つまみを「＋0.5時間」で3回押しても
  //   (30分/60分/90分)、選ばれる記録は 0分 の1枚のまま＝「片山 あと4分」が3回とも同じ数字だった
  //   （2026-09-04 実測・本番の写し633ロット）。playPace.js の札は「記録は30分ごと」と言っていたが、
  //   Panel が送る snapshotEveryMs(30分) は snapshotTargets が有ると **読まれない**（simulate.js:337）。
  //   → 5日以内の時は、粗い目盛りに **直接作業30分ごと** の細かい目盛りを足す。
  //     ・時刻は calendar.addDirectWorkMs で出す＝夜・休憩・土日には1枚も撮らない（実時間30分ではない）。
  //     ・粗い目盛り(0.3日刻み・終点5.0)はそのまま残す（snapshotCoverage と試験の言う「5日ぶん」の根拠）。
  //     ・枚数は 5日×420分÷30分 ≒ 70枚 ＋ 18枚 で、MAX_SNAPSHOTS(600) に遠い。
  //   ⚠ 30日は1日刻みのまま（30日の盤は日単位で見る物。ここでは触らない）。
  const coarseTargets = buildSnapshotTargets({ calendar, baseNow: now, horizonDays });
  const snapshotTargets = (() => {
    const hz = Number(horizonDays);
    let capMs = null;
    try { capMs = calendar.dayCapacityMs(); } catch { capMs = null; }
    if (!(hz > 0 && hz <= 5) || !(snapshotEveryMs > 0) || !(Number.isFinite(capMs) && capMs > 0)) return coarseTargets;
    const byMs = new Map(coarseTargets.map((t) => [t.targetMs, t]));
    const horizonWorkMs = hz * capMs;
    for (let w = snapshotEveryMs; w < horizonWorkMs; w += snapshotEveryMs) {
      let t;
      try { t = calendar.addDirectWorkMs(now, w); } catch { break; }
      if (!Number.isFinite(t) || byMs.has(t)) continue;
      // elapsedDays は「直接作業の日数」。0.3 の目盛りと同じ物差し（小数3桁に丸めるだけ。値は作らない）。
      byMs.set(t, { elapsedDays: Math.round((w / capMs) * 1000) / 1000, targetMs: t });
    }
    return [...byMs.values()].sort((a, b) => a.targetMs - b.targetMs || a.elapsedDays - b.elapsedDays);
  })();
  const simScenario = { ...scenarioIn, snapshotEveryMs, snapshotTargets };
  const base = simulateOperations({ normalized, eligibility, calendar, scenario: simScenario }, { signal });
  end('simulate');

  // ── ③′ 実測の引き直し(S2 2026-08-28) ───────────────────────────────────
  //   割付・順番はS1の1本のまま(approximation:'order-fixed')。各ジョブの時間だけ
  //   実測の束(工程×型式×作業者・階段①〜④)から種付き乱数で引き直し、
  //   「納期(当日いっぱい)に何回中何回収まったか」を出す。
  //   ⚠失敗してもシミュレーション本体は殺さない(resample.ok:false を積むだけ)。
  await begin('resample');
  try {
    const t0 = nowStamp();
    // 🚀 実測の束は入力(dataKey)だけで決まるので、solo / durationStats と同じく使い回す。
    //   ⚠ 使い回さないと「もう一度計算」のたびに全ロットのタスクを数え直す(実測で約1.4秒)。
    let samplesIndex;
    if (dataKey && cache.dataKey === dataKey && isObj(cache.durationSamples)) {
      samplesIndex = cache.durationSamples;
    } else {
      samplesIndex = buildDurationSamples({ lots });   // 実測の束は完了ロット由来なので絞る前の lots
      if (dataKey) cache.durationSamples = samplesIndex;
    }
    const tSamples = nowStamp();
    const jobMetaById = new Map(asArray(normalized.jobs).map((j) => [String(j.jobId), { processKey: j.processKey, model: j.model }]));
    const asg = asArray(base.assignments);
    const draws = asg.length > 800 ? 300 : 1000;   // 性能は本番の形で測る決まり。多い時は回数を落とし、回数は結果に必ず載せる
    const skipped = { noDue: 0, pastDue: 0, notJudgeable: 0, capped: 0 };
    const targets = asArray(base.lotResults)
      .filter((lr) => {
        if (!lr) return false;
        if (lr.alreadyPastDue) { skipped.pastDue += 1; return false; }
        if (!lr.judgeable) { skipped.notJudgeable += 1; return false; }
        if (lr.dueLineMs == null) { skipped.noDue += 1; return false; }
        return true;
      })
      .sort((a, b) => (a.dueLineMs ?? Infinity) - (b.dueLineMs ?? Infinity));
    const CAP = 120;   // 一晩版の上限。超えた分は納期の遠い順に諦め、諦めた事を正直に返す
    if (targets.length > CAP) skipped.capped = targets.length - CAP;
    const picked = targets.slice(0, CAP);
    // 🚀 2026-08-30: 1本ずつ「全ロットの割当を丸ごと積み直す」のをやめ、**1回の引き直し**で
    //   全部のロットの終わりを拾う(resampleLotsFinish)。同じ乱数・同じ材料・同じ順で
    //   進めるので **数字は1つも変わらない**(なぜ変わらないかは resample.js の説明)。
    const dueMsByLot = new Map(picked.map((lr) => [String(lr.lotId), lr.dueLineMs]));
    const batch = resampleLotsFinish({
      assignments: asg, samplesIndex, dueMsByLot, draws,
      seed: RESAMPLE_SEED, calendar, lotIds: picked.map((lr) => String(lr.lotId)), jobMetaById,
    });
    const byLot = batch.byLot;
    const t1 = nowStamp();
    base.resample = {
      byLot, draws, seed: RESAMPLE_SEED, tookMs: Math.round(t1 - t0), skipped, judged: picked.length,
      // 内訳(開発時の見張り用。判定には一切使わない)。
      partsMs: { samples: Math.round(tSamples - t0), draw: Math.round(t1 - tSamples) },
    };
  } catch (err) {
    base.resample = { byLot: {}, ok: false, reason: '引き直しの計算に失敗: ' + String((err && err.message) || err) };
  }
  end('resample');

  // ── ④ 全員がどの工程も持てる仮定で、もう一度 ─────────────────────────────
  let allSkills = null;
  if (compareAllSkills) {
    await begin('allSkills');
    const eligibilityAll = buildEligibility({
      soloResult: solo, workers, skillConfig, mode: MODE_ALL, scenario: scenarioIn,
    });
    allSkills = simulateOperations({
      normalized,
      eligibility: eligibilityAll,
      calendar,
      // 写真は撮らない。この結果は「原因の切り分け」にしか使わず、盤面には出さない。
      // 撮ると同じ枚数だけ無駄に太る。
      scenario: { ...simScenario, snapshotEveryMs: 0 },
    }, { signal });
    end('allSkills');
  }

  // ── ⑤ 原因と対策 ─────────────────────────────────────────────────────────
  await begin('explain');
  const explain = explainResult({
    base, allSkills, normalized,
    // 🚨🚨 2026-09-01 W-2 を実コードから確かめた結果。**空で正しい。**
    //   「押した手」＝人がシナリオを選んで計算し終えた結果の事だが、
    //   その保管庫は **画面の側** に在る(OperationsSimulationPanel.jsx:969
    //   `scenarioStoreRef = useRef({ key:null, byId:new Map() })`)。
    //   ここへ渡される payload は useOperationsSimulation.js:339-352 の
    //   lots / templates / workers / settings / now / horizonDays / scenario /
    //   mode / estimateMode / scenarioId / scopeLotIds / dataKey だけで、
    //   **他のシナリオの計算結果は1つも入っていない**（実コードを読んで確認）。
    //   つまり Worker が1回で手にする結果は base（＝いま押した条件そのもの）と
    //   allSkills（＝人が押していない仮定）の2つだけ。
    //   → ここに何かを入れると、それは **私が作った嘘の手** になる。入れない。
    //   その結果 remedyPick.best は null（＝「押した手が無い」）になる。
    //   これは欠陥ではなく、規則どおりの正しい答え（remedyRank.js:101-103）。
    //   🚨 画面は remedies[0] を自分で選び直さず remedyPick を読む事。
    //     選び直すと、押していない仮定が『一番効く手』の顔をする（矛盾Aそのもの）。
    //   ⚠ 押した手を今日の判断でも効かせたいなら、直す所は Worker ではなく
    //     「保管庫を持っている画面側から explainResult を呼び直す」道。別件。
    //
    // 🚨 同じ土俵かを確かめる材料。渡さないと、別条件の結果が
    //   「測定済みの効果」に混ざる(T019)。上のとおり今は scenarios を渡していないので
    //   この照合は効かないが、外すと将来渡した時に黙って土俵が混ざる。
    scenarios: [],
    inputFingerprint: normalized.inputFingerprint, baseNow: now,
  });

  // 仕様書5.8 の ScenarioMetrics。画面はこれを覚えておいて「通常との差」を出す。
  //   ⚠ ここで作らないと、画面が同じ計算をもう一度することになる。
  const jobsById = new Map(asArray(normalized.jobs).map((j) => [j.jobId, j]));
  const mkMetrics = (res, scenarioId) => toScenarioMetrics(res, {
    scenarioId,
    inputFingerprint: normalized.inputFingerprint,
    baseNow: now,
    jobsById,
    // 🚨🚨 2026-09-01 W-1 の直し(配線)。ここは以前この3つを渡していなかった。
    //   scenarios.js:252-270 は「カレンダーと期間を渡されなければ **null のまま返す**」
    //   と決めている(夜と土日を落とせないので『働ける時間』が出せない為)。
    //   渡していなかったので、本番の画面が受け取る availableMinutes は
    //   **いつも null** だった(本物のパイプラインを1回回して実測。
    //   availableMinutes:null / availableMinutesFrom:null / assignedMinutes:60)。
    //   段2が純関数を直しても、画面には数字そのものが出ていなかった。
    //   ⚠ 2026-08-23「見張りが作り物を食っていて緑のまま本番だけ壊れていた」と同じ形。
    //     この配線を見る試験は screen-wiring.test.mjs（本物のパイプラインを回す物）。
    //   期間は供給・需要と**同じ物差し**を使う(now 〜 normalized.horizonEnd)。
    //   別の期間を渡すと、上の workableMinutesOf と違う土俵の数が画面へ出る。
    calendar,
    fromMs: now,
    toMs: normalized.horizonEnd,
  });
  const metrics = mkMetrics(base, str(p.scenarioId) || SCENARIO_ID.BASELINE);
  const allSkillsMetrics = allSkills ? mkMetrics(allSkills, SCENARIO_ID.ALL_SKILLS) : null;
  // 🚨 5.9 非悪化保証。全員万能の解が通常より悪ければ通常解を採る。
  //   悪い解のまま「万能でも直らない＝仕事量が原因」と言わせない。
  const allSkillsResolved = allSkillsMetrics ? resolveAllSkills(metrics, allSkillsMetrics) : null;
  // 🚨 5.10 原因は1つに絞らない。主因・副因・判定上の不足の3段。
  const causeTiers = classifyCauses({
    baseline: metrics,
    allSkills: allSkillsResolved,
    absence: null,   // 欠員は画面が別シナリオとして回した時に比べる（同じ土俵の物だけ）
    inputQuality: normalized.inputQuality,
  });
  end('explain');

  await guard();
  onProgress('done', PHASE_LABEL.done, 1);

  const meta = {
    lotsIn: lots.length,
    lotsScoped: scopedLots.length,
    lotsSimulated: asArray(normalized.lots).length,
    workersIn: workers.length,
    templatesIn: templates.length,
    horizonDays,
    snapshotEveryMs,
    compareAllSkills,
    usedCachedHistory: historyFromCache,
    usedCachedNormalize: normalizeFromCache,
    phaseMs,
  };

  // ── ⑥ 教育提案（F3・読み取り専用）─────────────────────────────────────
  //   🚨 ここは **提案だけ**。認定も実施記録も書かない（仕様書C5）。
  await begin('education');
  const education = (() => {
    try {
      // 「この人はこの見立ての中で何分空いていたか」。
      // 🚨🚨 2026-08-23 是正: ここは以前 idleLog の区間を **そのまま足していた**。
      //   idleLog は同じ時間帯を何度も記録するので、重なりを畳まないと二重三重に数える。
      //   実測で 村さん 133.7時間 と出た（5日の通常勤務なら **1人最大35時間**）。
      //   この数字で教育を勧めると、**実際には空いていない人にOJTを勧める**。
      //   → 期間で切る → 重なりをまとめる → **勤務できる時間との共通部分だけ** を数える。
      //   🚨 2026-09-01 段1-③ 言葉を分けた。ここが出すのは
      //     **「空いていた時間」**（OJTを差し込む隙間を探す為の数）であって、
      //     足りる/足りないの判定に使う **「働ける時間」** ではない。
      //     判定側は下の workableMinutesOf。混ぜると「忙しいほど足りない」に化ける。
      const freeMinutesByWorker = freeMinutesByWorkerOf({
        idleLog: base.idleLog,
        calendar,
        fromMs: now,
        toMs: normalized.horizonEnd,
      });

      // 工程ごとの「要る時間」と「持てる人が働ける時間」。
      // 🚨🚨 2026-09-01 是正(段1-①): ここは以前 `Number(l.dueLineMs)` と書いていた。
      //   **`Number(null)` は 0**。つまり納期の入っていないロットが
      //   「1970年1月1日に納期が来た仕事」に化けていた（実測で earliestDueMs が 0 になった）。
      //   期間で切っていない今は表に出にくいが、月で切った瞬間に
      //   **どの月にも入って、12か月ぶんなら同じ仕事を12回数える**。
      //   納期が無い物は 0 にせず null のまま渡す（forecast.js の num() が null を弾く）。
      const dueLineByLot = new Map(asArray(normalized.lots)
        .map((l) => [str(l.lotId), l.dueLineMs == null ? null : Number(l.dueLineMs)]));
      // 🚨🚨 2026-09-01 是正(段1-②): 第3引数 `untilMs` を渡していなかった。
      //   口は forecast.js:73 に最初からあり、「この時刻より後に納期が来る仕事は数えない」と
      //   書いてある。渡さないので需要が **残っている仕事の全部** になり、
      //   供給だけが期間で切られていた（＝需要と供給の物差しが違う）。
      //   実測(作り物のデータ): 5日で見ても30日で見ても需要が 11,700分 で同じ。
      //   日数で割るので人数だけが 5.57人 → 0.93人＝6.0倍 動いていた。
      //   ⚠ 納期が **無い** 仕事は落とさない（落とすと需要が小さく見える）。
      //     落とさない事は forecast.js:85 が受け持っている。
      const demand = buildProcessDemand({
        jobs: asArray(normalized.jobs),
        dueLineByLot,
        untilMs: normalized.horizonEnd,
      });
      // 🚨 buildJobs は工程名(title)を持たない。埋めないと画面に
      //   `12:6a6e6edd7f2a:744b92` という鍵がそのまま出る（実際に出た）。
      //   normalized.lots[].steps[] から工程名を引いて入れる。
      const titleByProcessKey = new Map();
      for (const l of asArray(normalized.lots)) {
        for (const st of asArray(l.steps)) {
          const k = str(st.processKey);
          const t2 = str(st.title);
          if (k && t2 && !titleByProcessKey.has(k)) titleByProcessKey.set(k, t2);
        }
      }
      for (const e of demand.byProcess.values()) {
        if (!e.title) e.title = titleByProcessKey.get(e.processKey) || '';
      }
      // 🚨🚨 2026-09-01 是正(段1-③): 判定に使う供給を「余った時間」から「働ける時間」へ。
      //   前は workMinutesOf に freeMinutesByWorker（＝ idleLog 由来＝その人が **余った** 時間）を
      //   渡していた。余った時間は仕事が詰まっているほど 0 に近づくので、
      //   **忙しいほど必ず「時間が足りない」と出る**。しかも仕事の入り具合が変わるだけで
      //   「時間が足りない工程」が 4件 → 0件 に消える（作り物のデータでの実測）。
      //   判定に出すのは「その期間に**働ける**時間」＝勤務表・土日・休憩・休みを引いた分。
      //   これは calendar が持っている（normalized.calendarSpec の absences 込み）ので、
      //   ここで勤務表を読み直さない（同じ事を2か所で決めない）。
      //
      //   ⚠ 言葉を分ける。混ぜない:
      //       判定に出す  = 「働ける時間」  … workableMinutesOf（下）
      //       OJTの隙間に = 「空いていた時間」… freeMinutesByWorker（上。**消さない**。
      //                                        buildOjtCandidates が今も使っている）
      //   ⚠ この形は段1ぶんの場しのぎ。段3が
      //     workMinutesByWorkerBetween({ calendar, availability, names, fromMs, toMs }) を
      //     作ったら、そちらへ差し替える事。
      const workableCache = new Map();
      const workableMinutesOf = (name) => {
        const n = str(name).trim();
        if (!n) return null;
        if (workableCache.has(n)) return workableCache.get(n);
        let v = null;
        try {
          const ms = Number(calendar.workMsBetween(now, normalized.horizonEnd, n));
          v = Number.isFinite(ms) ? ms / 60000 : null;
        } catch {
          // 期間の取り方が壊れている時。0分にすると「必ず足りない」に化けるので null（分かりません）。
          v = null;
        }
        workableCache.set(n, v);
        return v;
      };
      const supply = buildProcessSupply({
        processKeys: demand.byProcess.keys(),
        eligibility,
        // その工程を持てる人が、この見立ての中で働ける分。
        workMinutesOf: workableMinutesOf,
      });
      const shortfalls = findShortfalls(demand.byProcess, supply);
      // 📅 2026-09-02: 区切りを数える時も工場の暦を番む。
      //   渡さないとここだけが曜日だけで数え、同じ画面の中で
      //   「営業日の数」が2通りになる(祝日を引いた盤と、引いていない帯)。
      const periods = buildPeriods({ baseNow: now, days: horizonDays, isWorkday: calendar.isWorkday });
      const future = findFutureShortfalls({ shortfalls, periods });

      const policy = isObj(normalized.policy) ? normalized.policy : {};
      const ojt = buildOjtCandidates({
        shortfalls,
        eligibility,
        workers,
        jobs: asArray(normalized.jobs),
        lots: asArray(normalized.lots),
        freeMinutesByWorker,
        // 🚨 60 を直書きしない。policy.js が持っている暫定値を使う。
        reserveMinutesPerDay: policy.provisionalReserveMinutesPerDay,
        horizonDays,
        baseNow: now,
      });
      // simulate がそのまま食える形。画面が「OJTを入れて計算し直す」時に使う。
      const ojtScenario = buildOjtScenario({
        candidates: asArray(ojt && ojt.candidates),
        maxPairs: policy.maxOjtPairsPerDay,
      });
      // ⚠ 講座(knowledge_courses)は Worker へ渡していないので、いまは必ず0件。
      //   結び付け(工程 → 講座)の持ち方も未定。**無理に結び付けない**。
      const study = buildStudyCandidates({ shortfalls, courses: [], eligibility, workers });

      return {
        // 「空いていた時間」。OJTを差し込む隙間を探す為の物。
        // 🚨 足りる/足りないの判定には使わない（2026-09-01 段1-③）。
        freeMinutesByWorker,
        // 「働ける時間」。判定（shortfalls）はこちらから出ている。
        workableMinutesByWorker: Object.fromEntries(workableCache),
        shortfalls,
        future,
        ojt,
        ojtScenario,
        study,
        notes: [
          '教育の提案です。認定も実施記録も書きません。',
          '講座（動画・確認テスト）はまだ繋いでいないので候補は0件です。',
        ],
      };
    } catch (e) {
      // 🚨 教育の提案が転んでも、本体の見立ては返す（現場を止めない）。
      return { error: oneLineError(e), shortfalls: [], future: null, ojt: null, ojtScenario: [], study: null };
    }
  })();
  end('education');


  // ── ⑦ 月ごと（2026-09-03 清水さん「一月毎に、月毎の必要な人材を確認する」）──────────
  //   🚨 計算は monthly.js（完成済み）を **呼ぶだけ**。ここで足し算・判定を書かない。
  //   🚨 「到着待ちに置かれたまま作業の記録が0件」の山は、数える／数えない の **両方** を
  //     ここで1回ずつ出す。画面はどちらかを選んで置くだけ（画面で数え直さない）。
  //   🚨 転んでも本体の見立ては返す（error を入れて画面が「出せませんでした」と言う）。
  await begin('monthly');
  const monthly = (() => {
    try {
      const periods = buildMonthPeriods({ baseNow: now, months: 3, isWorkday: calendar.isWorkday });
      // 🚨 Number(null) は 0（1970年）。null は null のまま渡す（forecast.js の num が弾く）。
      const dueLineByLot = new Map(asArray(normalized.lots)
        .map((l) => [str(l.lotId), l.dueLineMs == null ? null : Number(l.dueLineMs)]));
      // 山は **未完了のロットだけ** から数える（untouchedPile.js の注記どおり）。
      const openLots = scopedLots.filter(isOpenLot);
      // 🚨🚨 決まり22（2026-09-04 夜）。山を「入荷日で説明が付く／付かない」の2つに分ける。
      //   索引は normalizeInput が付けた印を読むだけ（決まり18 の arrivalAssumedKind と
      //   unknowns.arrivalUnknown / arrivalOverdue）。**新しい判定式を書かない**。
      const arrivalExplainByLot = buildArrivalExplainIndex({
        normalizedLots: asArray(normalized.lots), unknowns: normalized.unknowns,
      });
      const pile = buildUntouchedPile({ lots: openLots, arrivalExplainByLot });
      // 🚨 決まり22-3。仮に置く日数は **normalizeInput が答えた1か所** から取る（画面で数え直さない）。
      const assumeDaysBeforeDue = (normalized.inputQuality && normalized.inputQuality.arrival)
        ? normalized.inputQuality.arrival.assumeDaysBeforeDue : null;
      const roster = asArray(normalized.workers).map((w) => str(w && w.name).trim()).filter(Boolean);
      const cap = capacityByMonth({ calendar, availability: normalized.workers, roster, periods });
      const policy = isObj(normalized.policy) ? normalized.policy : {};
      const dayMinutes = policy.regularDirectMinutesPerDay;

      // 工程の鍵 → 工程名・テンプレ名・型式（決まり12: 型式だけでは意味が無い。テンプレを添える）。
      //   鍵を分解しない。normalized.lots[].steps[] が持っている物を引くだけ。
      const tplNameById = new Map(asArray(templates)
        .map((t) => [str(t && (t.id != null ? t.id : t.__id)), str(t && t.name)]));
      const procMeta = new Map();
      for (const l of asArray(normalized.lots)) {
        const tplName = tplNameById.get(str(l.templateId)) || '';
        for (const st of asArray(l.steps)) {
          const k = str(st.processKey);
          if (!k) continue;
          let m = procMeta.get(k);
          if (!m) { m = { title: str(st.title), templateName: tplName, models: new Set() }; procMeta.set(k, m); }
          if (l.model) m.models.add(str(l.model));
        }
      }
      /** 需要の箱に入っているロットの顔ぶれ（byProcess の lotIds の和集合。数え直しではない）。 */
      const lotIdsOf = (d) => {
        const out = new Set();
        if (d && d.byProcess instanceof Map) {
          for (const e of d.byProcess.values()) for (const id of (e.lotIds || [])) out.add(str(id));
        }
        return out;
      };
      const pickProcess = (p) => {
        const meta = procMeta.get(p.processKey) || null;
        return {
          processKey: p.processKey,
          title: p.title || (meta ? meta.title : ''),
          templateName: meta ? meta.templateName : '',
          models: meta ? [...meta.models].sort().slice(0, 4) : [],
          modelCount: meta ? meta.models.size : 0,
          requiredMinutes: p.requiredMinutes,
          unknownJobCount: p.unknownJobCount,
          jobCount: p.jobCount,
          lotCount: p.lotCount,
          workers: p.workers,
          workerCount: p.workerCount,
          ownerUnknown: p.ownerUnknown,
          workableMinutes: p.workableMinutes,
          shortMinutes: p.shortMinutes,
          shortPersonDays: p.shortPersonDays,
          note: p.note,
        };
      };
      /**
       * 🎓 決まり19B の材料②「教えるのに要る営業日」。
       *   ⚠ 判定も日数も educationLeadTime.js が持っている。ここは **材料を集めて渡すだけ**。
       *   🚨 材料が無い工程は source:'none' がそのまま返る。**0日で埋めない**（2026-08-20）。
       *   A（その工程が足りなくなる日）= その月の、その工程の一番早い納期線。
       *     ⚠ 納期線は dueLineByLot ただ1つから引く（別の所で作らない）。
       */
      const leadTimeFor = (month, dem) => {
        const dm = dem && Array.isArray(dem.months) ? dem.months[month.index] : null;
        const byProcess = dm && dm.byProcess instanceof Map ? dm.byProcess : new Map();
        // その月で「誰も持てない」または「足りない」工程だけを見る（全部見ても意味が無い）。
        const want = new Map();
        for (const q of asArray(month.unknownOwnerProcesses)) want.set(str(q.processKey), str(q.title));
        for (const q of asArray(month.shortProcesses)) want.set(str(q.processKey), str(q.title));
        const processes = [];
        for (const [key, title] of want) {
          const e = byProcess.get(key);
          let deadlineMs = null;
          for (const id of (e && e.lotIds ? e.lotIds : [])) {
            const dl = dueLineByLot.get(str(id));
            if (dl == null || !Number.isFinite(dl)) continue;
            if (deadlineMs == null || dl < deadlineMs) deadlineMs = dl;
          }
          processes.push({ processKey: key, title: title || (e ? str(e.title) : ''), deadlineMs });
        }
        return buildEducationLeadTime({
          processes,
          baseNowMs: now,
          // 🚨 🎓の印も卒業の記録も Worker へ渡っていない。**0件と書かず、渡っていないと言う**。
          graduations: null,
          recordCells: null,
          materials: { traineeMarkCount: null, teachMarkCount: null, graduationCount: null },
          holidaysKnown: false,
        });
      };

      const runOne = (countPile, withLeadTime = false) => {
        const jobsAll = asArray(normalized.jobs);
        const jobs = countPile ? jobsAll : jobsAll.filter((j) => {
          const v = pile.byLot.get(str(j.lotId));
          return !(v && v.pile === true);
        });
        const dem = demandByMonth({ jobs, dueLineByLot, periods, nowMs: now, pileByLot: countPile ? pile.byLot : null });
        const outlook = buildMonthlyOutlook({
          periods, demandByMonth: dem, capacityByMonth: cap, eligibility, dayMinutes, holdingWord: '到着待ち',
          // 🚨 決まり22-3。判定の言葉に添える1文の言い回しにだけ使う（計算には1回も使わない）。
          assumeArrivalDaysBeforeDue: assumeDaysBeforeDue,
        });
        const overdueLotIds = lotIdsOf(dem.outside.overdue);
        let overdueNoArrival = 0;
        for (const l of asArray(normalized.lots)) {
          if (overdueLotIds.has(str(l.lotId)) && l.assignable !== true) overdueNoArrival += 1;
        }
        return {
          months: outlook.months.map((m, i) => ({
            index: m.index, label: m.label, ym: m.ym, fromMs: m.fromMs, toMs: m.toMs,
            workdays: m.workdays, calendarDays: m.calendarDays, monthWorkdays: m.monthWorkdays,
            monthCalendarDays: m.monthCalendarDays, rangeLabel: m.rangeLabel, monthRangeLabel: m.monthRangeLabel,
            requiredMinutes: m.requiredMinutes, workableMinutes: m.workableMinutes,
            shortMinutes: m.shortMinutes, shortPersonDays: m.shortPersonDays,
            peopleForWholeMonth: m.peopleForWholeMonth,
            peopleForWholeMonthDenominatorWorkdays: m.peopleForWholeMonthDenominatorWorkdays,
            sparePersonDays: m.sparePersonDays, dayMinutes: m.dayMinutes,
            overdue: m.overdue, pile: m.pile, isPartialMonth: m.isPartialMonth, partialWhy: m.partialWhy,
            // 🚨 決まり22。山の2種と、判定の言葉に添える1文。画面はこれを出すだけ（数え直さない）。
            pileArrivalUnknown: m.pileArrivalUnknown, pileUnexplained: m.pileUnexplained,
            arrivalSentence: m.arrivalSentence,
            uncounted: m.uncounted, registeredDays: m.registeredDays, provisionalDays: m.provisionalDays,
            noDataDays: m.noDataDays, verdict: m.verdict, headline: m.headline, subline: m.subline,
            measureNote: m.measureNote, uncountedSentence: m.uncountedSentence,
            unjudgeableWhy: m.unjudgeableWhy, provisionalNote: m.provisionalNote, notes: m.notes,
            /** 🚨 この月の箱に入っている件数（需要と同じ箱。数え直しではない） */
            jobCount: dem.months[i] ? dem.months[i].jobCount : 0,
            lotCount: lotIdsOf(dem.months[i]).size,
            processes: m.processes.map(pickProcess),
            shortProcessCount: m.shortProcesses.length,
            unknownOwnerProcessCount: m.unknownOwnerProcesses.length,
            /**
             * 🎓 決まり19B の材料②。教えるのに要る営業日と「今から始めて間に合うか」。
             *   🚨 材料が無い工程は source:'none' のまま返ります（0日で埋めていません）。
             *   ⚠ 山を数えない側では回しません（同じ物を2回計算しない）。
             */
            educationLeadTime: withLeadTime ? leadTimeFor(m, dem) : null,
          })),
          /** 🚨 納期がもう過ぎている分。どの月の要る時間にも不足人日にも1分も入っていない（別枠） */
          overdue: {
            lotCount: overdueLotIds.size,
            jobCount: dem.outside.overdueJobCount,
            minutes: dem.outside.overdueMinutes,
            /** うち、手が付けられない（到着の予定が無い／過ぎている）ロット */
            noArrivalLotCount: overdueNoArrival,
          },
          outside: {
            noDueJobCount: dem.outside.noDueJobCount,
            afterLastMonthJobCount: dem.outside.afterLastMonthJobCount,
          },
        };
      };

      // 週の山（納期が来る件数。WEEK_RULE.DUE＝納期線の週にただ1つ）。割付は渡さない（件数だけ要る）。
      const weekly = buildWeeklyBreakdown({ periods, assignments: [], calendar, dueLineByLot });
      const weeks = asArray(weekly.months).map((m) => ({
        label: m.label,
        weeks: asArray(m.weeks).map((w) => ({
          label: w.label, heading: w.heading, workdays: w.workdays, dueLotCount: w.dueLotCount,
        })),
      }));

      // 登録の事実（決まり2: 10月は「育っていく様子」を出す）。作らない。あるものだけ。
      let latestArrivalMs = null;
      for (const l of asArray(normalized.lots)) {
        const a = l.scheduledArrivalMs;
        if (Number.isFinite(a) && a > 0 && (latestArrivalMs == null || a > latestArrivalMs)) latestArrivalMs = a;
      }

      // 教育の材料（決まり5: 日数は出さない。材料の有無と、記録の長さだけ）。
      //   ⚠ 「教えられる」の指名（skill_marks）と 🎓 の出来事は、この計算に **渡っていない**。
      //     0件と書かない。「渡っていない」と書く（分かりません、の意味）。
      const readMs = (v) => {
        if (v == null || v === '') return null;
        if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
        if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
        if (typeof v === 'object' && typeof v.toMillis === 'function') { try { return v.toMillis(); } catch { return null; } }
        const n = Date.parse(String(v));
        return Number.isFinite(n) ? n : null;
      };
      let traineeTaskCount = 0;
      let firstRecordMs = null;
      let completedLotCount = 0;
      for (const l of asArray(lots)) {
        const tasks = isObj(l.tasks) ? l.tasks : null;
        if (tasks) for (const t of Object.values(tasks)) { if (t && t.trainee === true) traineeTaskCount += 1; }
        if (l.status === 'completed' || l.location === 'completed') {
          completedLotCount += 1;
          const c = readMs(l.completedAt);
          if (c != null && (firstRecordMs == null || c < firstRecordMs)) firstRecordMs = c;
        }
      }

      return {
        ok: true,
        baseNow: now,
        months: 3,
        roster,
        dayMinutes,
        holdingWord: '到着待ち',
        /** 到着待ち かつ 作業の記録0件 のロット数（未完了だけ） */
        pileLotCount: pile.pileLotCount,
        /** 🚨 決まり22。山の2種。足すと pileLotCount になる（1つに混ぜない） */
        pileArrivalUnknownLotCount: pile.pileArrivalUnknownLotCount,
        pileUnexplainedLotCount: pile.pileUnexplainedLotCount,
        pileArrivalWhyCounts: pile.pileArrivalWhyCounts,
        assumeArrivalDaysBeforeDue: assumeDaysBeforeDue,
        openLotCount: openLots.length,
        withPile: runOne(true, true),
        withoutPile: runOne(false),
        weeks,
        /** ロットごとの要る時間(分)。全体進捗の週次仕事量が読む。🚨 monthly.js の demandByLot(足すだけ)。 */
        demandByLot: demandByLot(asArray(normalized.jobs)),
        latestArrivalMs,
        materials: {
          traineeTaskCount,
          teachMarksProvided: false,
          firstRecordMs,
          completedLotCount,
        },
        maxOjtPairsPerDay: policy.maxOjtPairsPerDay,
      };
    } catch (e) {
      return { ok: false, error: oneLineError(e) };
    }
  })();
  end('monthly');

  // ── ⑧ スキルを仮に付けて引き直す（決まり19B の材料①・**押した時だけ**）────────
  //   清水さん(2026-09-03):「その暇な理由が仕事が全くないのか **スキルがない** のかって話が
  //     やっとでてくるよね(ここがかなり重要)」への答え。
  //   🚨 候補の選び方も比べ方も decisionBoard.js が持っている。ここは **引き直しを回すだけ**。
  //   🚨 数を引き算で作らない。1件 = 1回の本物の割付。
  //   ⚠ 実測(本番の写し249ロット・5営業日): 1回 約3.0秒。4件で約12秒。
  //     だから既定は走らせない。画面が「押した」時だけ runSkillTrials:true で呼ぶ。
  let skillTrials = null;
  if (runSkillTrials) {
    await begin('skillTrials');
    const trialMs = [];
    try {
      const candidates = buildSkillTrialCandidates({
        base, normalized, maxTrials: maxSkillTrials, maxPerWorker: 1,
      });
      const rows = [];
      for (const cand of candidates) {
        await guard();
        // 🚨 仮に持たせるのは **この工程だけ**。元の eligibility は1バイトも書き換えない。
        //   ⚠ 印(assumed:true)を必ず残す。記録から出た候補と見分けが付かなくなる。
        const trialEligibility = {
          ...eligibility,
          eligibleFor: (key) => {
            const list = asArray(eligibility.eligibleFor(key));
            if (str(key) !== str(cand.processKey)) return list;
            const has = list.some((c) => str(typeof c === 'string' ? c : (c && c.name)) === str(cand.worker));
            if (has) return list;
            return [...list, {
              name: cand.worker, taskCount: 0, assumed: true,
              evidence: '仮に持たせた候補です（この工程の記録はありません）',
            }];
          },
        };
        const t0 = nowStamp();
        const trial = simulateOperations(
          { normalized, eligibility: trialEligibility, calendar, scenario: simScenario }, { signal },
        );
        trialMs.push(Math.round(nowStamp() - t0));
        rows.push(compareSkillTrial({ base, trial, candidate: cand }));
      }
      // 🚨 候補が0件だった時に「効きません」と読ませない。**なぜ0件なのか**を数で言う。
      //   ⚠ ここで数を作らない。base の記録を数えるだけ（実測 2026-09-04・製品の写し249ロット:
      //     技能の当てが無いで空いた区間 0件／誰にも渡せなかった仕事 134件）。
      const idleByReason = {};
      for (const row of asArray(base.idleLog)) {
        const k = str(row && row.reason) || '(理由なし)';
        idleByReason[k] = (idleByReason[k] || 0) + 1;
      }
      const unresolvedByReason = {};
      for (const row of asArray(base.unresolved)) {
        const k = str(row && row.reason) || '(理由なし)';
        unresolvedByReason[k] = (unresolvedByReason[k] || 0) + 1;
      }
      skillTrials = {
        ok: true,
        rows,
        candidateCount: candidates.length,
        /**
         * 🚨 候補が0件の時に必ず読む所。「効きません」ではなく「入口が空でした」。
         *   候補の入口は decisionBoard.js の
         *   「技能の当てが無い で空いた区間」ただ1つなので、そこが0件なら候補も0件になる。
         */
        whyNoCandidate: candidates.length > 0 ? null : {
          idleByReason,
          unresolvedByReason,
          sentence: '「技能の当てが無い」で手が空いた時間が1件も記録されていないので、'
            + '仮に付ける候補が作れませんでした。'
            + `誰にも渡せなかった仕事は ${asArray(base.unresolved).length}件 あります。`
            + '（候補の入口が「手が空いた時間」だけなので、'
            + '手が空く前に仕事が尽きている時は候補が出ません）',
        },
        /** 🚨 段ごとの実測(ms)。押した時に何秒待つかを画面がそのまま言える */
        trialMs,
        totalMs: trialMs.reduce((a, b2) => a + b2, 0),
        notes: [
          '1件 = 実際に割付を1回やり直した結果です（引き算で作った数ではありません）。',
          '仮に持たせただけで、力量マスタへは1バイトも書いていません。',
          '効かなかった候補も消していません（improves:false のまま出します）。',
        ],
      };
    } catch (e) {
      skillTrials = { ok: false, error: oneLineError(e), rows: [], trialMs };
    }
    end('skillTrials');
  }

  // ── 段ごとの内訳を、開発時だけ1行で出す ──────────────────────────────────
  //   🚨 これは **計測** であって判定ではない。数字は meta.phaseMs にも入っているので、
  //      画面が「条件・根拠」へ出したい時はそちらを読む(ここでは画面へ何も足さない)。
  //   ⚠ 本番のビルドでは出さない(import.meta.env.DEV が真の時だけ)。
  logPhaseBreakdown(meta, base);

  // 🚚 2026-09-22 技能の記録(最終検査の Worker と同じ写し方)。eligibility そのもの(関数を持つ)は別スレッドから写せないので
  //   **実際に配る時に使った eligibleFor** を工程の鍵ごとに1回ずつ呼んで名前の配列だけを写す(数え直しではない)。
  //   空配列 = 「分かりません」(誰にも記録が無い)であって、やれないという意味ではない。
  const eligibleNamesByProcess = {};
  {
    const keys = new Set(Object.keys(eligibility.byProcess || {}));
    asArray(normalized.jobs).forEach((j) => { if (j && j.processKey != null) keys.add(String(j.processKey)); });
    keys.forEach((k) => {
      const list = typeof eligibility.eligibleFor === 'function' ? eligibility.eligibleFor(k) : [];
      eligibleNamesByProcess[k] = asArray(list).map((c) => (typeof c === 'string' ? c : str(c && c.name))).filter(Boolean);
    });
  }
  return {
    base, allSkills, explain, normalized, meta, eligibleNamesByProcess,
    metrics, allSkillsMetrics, allSkillsResolved, causeTiers, education, monthly,
    /** 🚨 押した時だけ。押していない時は null（0件ではない＝「回していません」） */
    skillTrials,
    /**
     * 🚨 画面(src/opsim/nextMonth/)が読む名前。**同じ物の別名**です。
     *   ⚠ ここで数を作り直していません（同じ配列をそのまま指しています）。
     *   決まり19B の「来月の手当て」画面は result.decisionBoard.trials を読みます。
     */
    decisionBoard: skillTrials
      ? { trials: skillTrials.rows, whyNoCandidate: skillTrials.whyNoCandidate || null, trialMs: skillTrials.trialMs }
      : null,
    /**
     * 🚨 同じく画面が読む名前。**月の行に入っている物と同じ**（作り直していません）。
     *   ⚠ 画面は1か月ぶんしか受け取れないので、来月(index 1)を既定で渡し、
     *     来月に行が無ければ 行のある最初の月を渡します。どの月かは monthIndex で分かります。
     */
    educationLeadTime: (() => {
      const ms = (monthly && monthly.ok && monthly.withPile && Array.isArray(monthly.withPile.months))
        ? monthly.withPile.months : [];
      const pick = (ms[1] && ms[1].educationLeadTime && ms[1].educationLeadTime.rows.length > 0)
        ? ms[1]
        : ms.find((m) => m.educationLeadTime && m.educationLeadTime.rows.length > 0) || ms[1] || ms[0] || null;
      return pick && pick.educationLeadTime
        ? { ...pick.educationLeadTime, monthIndex: pick.index, monthLabel: pick.label }
        : null;
    })(),
  };
}

/**
 * 段ごとのミリ秒を表で出す(開発時だけ)。
 * 出す物: 履歴 / 正規化 / 通常の割付 / 引き直し / 全員万能 / 原因 / 教育。
 * 🚨 ここで数字を作らない。上で実測した値をそのまま並べるだけ。
 */
export function logPhaseBreakdown(meta, base) {
  let dev = false;
  try { dev = !!(import.meta && import.meta.env && import.meta.env.DEV); } catch { dev = false; }
  if (!dev) return;
  if (typeof console === 'undefined' || !console) return;
  const ph = (meta && meta.phaseMs) || {};
  const parts = (base && base.resample && base.resample.partsMs) || {};
  const rows = [
    { 段: '① 履歴(担当できる人・実績の統計)', ミリ秒: ph.history ?? null },
    { 段: '② 正規化(ロット→仕事の形)', ミリ秒: ph.normalize ?? null },
    { 段: '③ 通常の割付', ミリ秒: ph.simulate ?? null },
    { 段: '③′ 引き直し(合計)', ミリ秒: ph.resample ?? null },
    { 段: '　　└ 実測の束を作る', ミリ秒: parts.samples ?? null },
    { 段: '　　└ 引き直し本体', ミリ秒: parts.draw ?? null },
    { 段: '④ 全員万能(原因判定用)', ミリ秒: ph.allSkills ?? null },
    { 段: '⑤ 原因と対策', ミリ秒: ph.explain ?? null },
    { 段: '⑥ 教育の提案', ミリ秒: ph.education ?? null },
    { 段: '⑦ 月ごと', ミリ秒: ph.monthly ?? null },
  ];
  const sum = Object.keys(ph).reduce((a, k) => a + (Number(ph[k]) || 0), 0);
  rows.push({ 段: '合計(段の足し算)', ミリ秒: sum });
  // 表は読みやすいが、記録には残りにくい。1行の要約も一緒に出す。
  const one = `[操業シミュレーション] 段ごとの所要時間 合計${sum}ms`
    + ` (渡されたロット${meta.lotsIn}/範囲の中${meta.lotsScoped}/盤に載った${meta.lotsSimulated}・${meta.horizonDays}日)`
    + ` / 履歴${ph.history ?? '-'} / 正規化${ph.normalize ?? '-'} / 通常の割付${ph.simulate ?? '-'}`
    + ` / 引き直し${ph.resample ?? '-'}(束${parts.samples ?? '-'}+引き直し${parts.draw ?? '-'})`
    + ` / 全員万能${ph.allSkills ?? '-'} / 原因${ph.explain ?? '-'} / 教育${ph.education ?? '-'}`;
  console.log(one);
  if (typeof console.table === 'function') console.table(rows);
}

// =============================================================================
//  🕒 納期対応の残業・土曜(必要分)(2026-09-16 清水さん「必要なタイミングで必要な分をする計算」)
// -----------------------------------------------------------------------------
//  メッセージ kind:'overtimePlan'。payload は kind:'run' と同じ材料
//  (lots / templates / workers / settings / now / horizonDays / scenario / mode / estimateMode / scopeLotIds)
//  ＋ overtime: { stepMin, maxIterations }(任意)。
//  🚨 計算は既存の normalizeInput / makeCalendar / buildEligibility / simulateOperations をそのまま使う。
//     新しい割付の計算を書かない。「次に何を足すか」は overtimePlan.js(純関数)が決める。
//  🚨 時計を読まない(now は payload)。数字を推測で埋めない(遅れは simulate の lotResults.late そのまま)。
//  戻り: planOvertimeAsNeeded の戻り ＋ { maxExtraMin, stepMin, horizonYmds, saturdays, tookMs }
// =============================================================================
export async function runOvertimePlanPipeline(payload, opts = {}) {
  const p = isObj(payload) ? payload : {};
  const o = isObj(opts) ? opts : {};
  const signal = isObj(o.signal) ? o.signal : { aborted: false };
  const yieldToHost = typeof o.yieldToHost === 'function' ? o.yieldToHost : (() => Promise.resolve());

  const lots = asArray(p.lots);
  const templates = asArray(p.templates);
  const workers = asArray(p.workers);
  const settings = isObj(p.settings) ? p.settings : {};
  const now = Number(p.now);
  if (!Number.isFinite(now)) throw new Error('今の時刻(now)が渡っていません。呼ぶ側で1回だけ決めて渡してください');
  const hd = Math.trunc(Number(p.horizonDays));
  const horizonDays = (Number.isFinite(hd) && hd > 0) ? hd : DEFAULT_HORIZON_DAYS;
  const scenarioIn = isObj(p.scenario) ? p.scenario : {};
  const mode = (p.mode === undefined || p.mode === null) ? DEFAULT_MODE : p.mode;
  const estMode = (p.estimateMode === 'P50' || p.estimateMode === 'P75' || p.estimateMode === 'P90')
    ? p.estimateMode : DEFAULT_ESTIMATE_MODE;
  const scopeLotIds = Array.isArray(p.scopeLotIds) ? p.scopeLotIds.map(str).filter(Boolean) : null;
  const scopeSet = scopeLotIds ? new Set(scopeLotIds) : null;
  // 🚫 記録でほぼ毎回飛ばす工程(2026-09-18)。ここも全ロットから数える(kind:run と同じ純関数)。
  const skipHistory = skipHistoryOf({ lots, templates });
  const scopedLots = scopeSet ? lots.filter((l) => scopeSet.has(docIdOf(l))) : lots;
  const ot = isObj(p.overtime) ? p.overtime : {};
  const stepMin = (Number.isFinite(Number(ot.stepMin)) && Number(ot.stepMin) > 0) ? Math.trunc(Number(ot.stepMin)) : 30;
  const maxIterations = (Number.isFinite(Number(ot.maxIterations)) && Number(ot.maxIterations) > 0) ? Math.trunc(Number(ot.maxIterations)) : 40;

  const t0 = nowStamp();
  // ① 担当できる人・実績の統計(**全ロット**から。kind:'run' と同じ)
  const solo = computeSoloDependency({ lots, templates, workers });
  const skillConfig = buildSkillConfig({ settings, templates });
  const eligibility = buildEligibility({ soloResult: solo, workers, skillConfig, mode, scenario: scenarioIn });
  const durationStats = buildDurationStats({ lots });

  // ② 1回ぶんの引き直し。🚨 案の2つの鍵(extraByDay / workOnDays)だけを scenario に重ねる。比べ物(全員万能)は回さない。
  const runOnce = async (patch) => {
    await yieldToHost();
    if (signal.aborted) throw abortError();
    const pt = isObj(patch) ? patch : {};
    const sc = { ...scenarioIn, compareAllSkills: false };
    if (isObj(pt.extraByDay) && Object.keys(pt.extraByDay).length) sc.extraByDay = pt.extraByDay; else delete sc.extraByDay;
    if (isObj(pt.workOnDays) && Object.keys(pt.workOnDays).length) sc.workOnDays = pt.workOnDays; else delete sc.workOnDays;
    const normalized = normalizeInput({
      lots: scopedLots, templates, workers, settings, now, horizonDays, scenario: sc, durationStats, estimateMode: estMode,
      alwaysSkippedProcessKeys: skipHistory.keys,
    });
    const calendar = makeCalendar(normalized.calendarSpec);
    const base = simulateOperations({ normalized, eligibility, calendar, scenario: { ...sc, snapshotEveryMs: DEFAULT_SNAPSHOT_MS } }, { signal });
    // 遅れ = lotResults.late そのまま。担当者と手が付いた日は assignments から拾う(数を作らない)。
    const jobCountByLot = new Map();
    for (const j of asArray(normalized.jobs)) { const id = str(j && j.lotId); jobCountByLot.set(id, (jobCountByLot.get(id) || 0) + 1); }
    const byLot = new Map();
    for (const a of asArray(base.assignments)) {
      if (!a) continue;
      const id = str(a.lotId);
      if (!byLot.has(id)) byLot.set(id, { workers: new Set(), ymds: new Set(), lastEndMs: null, placed: 0 });
      const e = byLot.get(id);
      e.placed += 1;
      if (a.worker) e.workers.add(str(a.worker));
      if (a.partner) e.workers.add(str(a.partner));
      const y = ymdOfMs(a.startMs);
      if (y) e.ymds.add(y);
      // 期間の中で終わらないロットの「どこまで進んだか」= 手が付いた最後の仕事の終わり(実測。推測ではない)。
      if (Number.isFinite(Number(a.endMs)) && (e.lastEndMs == null || Number(a.endMs) > e.lastEndMs)) e.lastEndMs = Number(a.endMs);
    }
    const late = asArray(base.lotResults).filter((r) => r && r.late === true).map((r) => {
      const e = byLot.get(str(r.lotId)) || { workers: new Set(), ymds: new Set(), lastEndMs: null, placed: 0 };
      // 期間の中で手が付かなかった仕事の数(仕事の数 − 置けた数)。残業を足すと減る＝進んだ。
      const remainingJobs = Math.max(0, (jobCountByLot.get(str(r.lotId)) || 0) - e.placed);
      return { lotId: str(r.lotId), dueMs: r.dueLineMs ?? null, finishMs: r.finishMs ?? null, lastEndMs: e.lastEndMs, remainingJobs, workers: [...e.workers], workYmds: [...e.ymds].sort() };
    });
    return { late, lateCount: late.length, normalized, calendar };
  };

  // ③ 期間の営業日と土曜(工場の休み)。🚨 数えるのは normalizeInput の horizonEnd と calendar.isWorkday(自前で曜日を決めない)。
  const probe = await runOnce({});
  const cal = probe.calendar;
  const horizonYmds = [];
  const saturdays = [];
  {
    const d = new Date(now); d.setHours(0, 0, 0, 0);
    let guard = 0;
    while (d.getTime() <= probe.normalized.horizonEnd && guard < 400) {
      const ms = d.getTime();
      const y = ymdOfMs(ms);
      if (cal.isWorkday(ms)) horizonYmds.push(y);
      else if (weekdayOfYmd(y) === SATURDAY) saturdays.push(y);
      d.setDate(d.getDate() + 1);
      guard += 1;
    }
  }
  const policy = probe.normalized.policy || {};
  const dayMin = Number(probe.normalized.calendarSpec && probe.normalized.calendarSpec.directMinutesPerDay);
  const maxExtraMin = Math.max(0, Math.trunc(Number(policy.overtimeDirectMinutesPerDay) - dayMin) || 0);
  const names = workers.map((w) => str(w && w.name)).filter(Boolean);

  const plan = await planOvertimeAsNeeded({
    runOnce: async (patch) => { const r = await runOnce(patch); return { late: r.late, lateCount: r.lateCount }; },
    workers: names, horizonYmds, saturdays, stepMin, maxExtraMin, maxIterations, nowMs: now,
  });
  return { ...plan, maxExtraMin, stepMin, horizonYmds, saturdays, tookMs: Math.round(nowStamp() - t0) };
}

// =============================================================================
//  ここから下は Worker の中でだけ動く
// -----------------------------------------------------------------------------
//  🚨 このファイルは「Worker が作れない端末でのやり直し」用に、メインスレッドから
//     import される事もある。その時に window の message を拾いに行くと、
//     関係の無いメッセージを計算の依頼と取り違える。だから必ず場所を確かめる。
// =============================================================================
const IN_WORKER = typeof window === 'undefined'
  && typeof self !== 'undefined'
  && typeof self.postMessage === 'function';

/** 区切りで一度だけ制御を返す。🚨 これは別スレッド化ではない（上の注記のとおり）。 */
function yieldToHost() {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

if (IN_WORKER) {
  let currentRunId = null;
  let currentToken = null;
  const cache = {};

  const post = (msg) => {
    try {
      self.postMessage(msg);
    } catch (e) {
      // 送れない形の物を入れてしまった時に、黙って消えないようにする。
      self.postMessage({
        runId: msg && msg.runId, kind: 'result', ok: false, error: oneLineError(e),
      });
    }
  };

  const handleRun = async (msg) => {
    const runId = (msg && msg.runId !== undefined && msg.runId !== null) ? msg.runId : null;

    // 連打で結果が入れ替わらないように、走っている物を先に捨てる。
    if (currentToken) currentToken.abort();
    currentRunId = runId;
    const token = makeAbortToken();
    currentToken = token;

    const startedAt = nowStamp();
    try {
      const result = await runOperationsSimulationPipeline(msg, {
        signal: token.signal,
        cache,
        yieldToHost,
        isCurrent: () => currentRunId === runId,
        onProgress: (phase, label, ratio) => {
          if (currentRunId !== runId) return;
          post({ runId, kind: 'progress', phase, label, ratio });
        },
      });
      if (currentRunId !== runId) return;
      post({ runId, kind: 'result', ok: true, result, elapsedMs: Math.round(nowStamp() - startedAt) });
    } catch (err) {
      if (token.signal.aborted || currentRunId !== runId) {
        post({ runId, kind: 'aborted', reason: (err && err.message) ? String(err.message) : '中止しました' });
        return;
      }
      post({ runId, kind: 'result', ok: false, error: oneLineError(err) });
    } finally {
      if (currentRunId === runId) {
        currentRunId = null;
        currentToken = null;
      }
    }
  };

  self.addEventListener('message', (ev) => {
    const msg = isObj(ev && ev.data) ? ev.data : null;
    if (!msg) return;
    const kind = str(msg.kind) || 'run';

    if (kind === 'abort') {
      const target = (msg.runId === undefined || msg.runId === null) ? currentRunId : msg.runId;
      if (currentToken && target === currentRunId) {
        currentToken.abort();
        post({ runId: currentRunId, kind: 'aborted', reason: '中止しました' });
      }
      return;
    }
    if (kind === 'run') {
      // 🚨 await しない。ここで待つと、走っている間に届く中止を受け取れなくなる。
      handleRun(msg);
      return;
    }
    if (kind === 'overtimePlan') {
      // 🕒 納期対応の残業・土曜(必要分)。盤の計算(run)とは別の依頼なので、走っている物を止めない。
      //   ⚠ 画面は はしごと同じく **別の Worker** を立てて呼ぶ(盤の Worker へ割り込ませない)。
      const runId = (msg.runId !== undefined && msg.runId !== null) ? msg.runId : null;
      const startedAt = nowStamp();
      runOvertimePlanPipeline(msg, { yieldToHost })
        .then((result) => post({ runId, kind: 'result', ok: true, result, elapsedMs: Math.round(nowStamp() - startedAt) }))
        .catch((err) => post({ runId, kind: 'result', ok: false, error: oneLineError(err) }));
      return;
    }
    if (kind === 'ping') {
      post({ kind: 'ready' });
    }
  });

  self.addEventListener('messageerror', () => {
    post({ runId: currentRunId, kind: 'result', ok: false, error: '計算へ渡すデータを別スレッドへ写せませんでした（形が写せない値が混じっています）' });
  });

  post({ kind: 'ready' });
}
