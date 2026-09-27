// =============================================================================
//  parallelLab/phaseProfile.js — 並列作業の比較に使う「自動運転の残り・終了後の人の対応・離れてよいか・往復」を
//  記録と登録から組み立てる純関数(2026-09-22 夜)。設計: docs/並列作業_比較シミュレーション_設計.md
// -----------------------------------------------------------------------------
//  🚨 推測しない。無い物は missing に名指しで返し、その工程は比較対象外にする。
//    - 自動の残り: 工程の autoEndSec(設定)から。本番の記録 942件のうち 496件が「時計で自動終了」= duration が autoEndSec そのもの。
//      autoEndSec が 0 の工程は「自動時間 未登録」(記録の duration を機械の実時間と断定しない)。
//    - 終了後の人の対応(finishWorkMin): 記録に無い(manualTime>0 は 128件・中央値 1秒) → 登録から。
//    - 離れてよいか(mayLeave): 記録に無い → 登録から。isAutoStep から推測しない。
//    - 往復(travelMin): 場所どうしの分数の登録から。距離から推測しない。
// =============================================================================
import { isAutoStep } from '../workExecution.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (Number.isFinite(v) ? v : null);
const str = (v) => (v == null ? '' : String(v));

/** settings.opsim.parallelLab の形。登録が無ければ全部 空。 */
export const readParallelLabConfig = (settings) => {
  const op = isObj(settings) && isObj(settings.opsim) && isObj(settings.opsim.parallelLab) ? settings.opsim.parallelLab : {};
  return {
    mayLeave: isObj(op.mayLeave) ? op.mayLeave : {},              // stepId → true/false
    finishWorkMin: isObj(op.finishWorkMin) ? op.finishWorkMin : {}, // stepId → 分
    interruptible: isObj(op.interruptible) ? op.interruptible : {}, // stepId → true/false(未登録=中断できない・安全側)
    travelMin: isObj(op.travelMin) ? op.travelMin : {},            // "zoneA|zoneB" → 分(片道)
    returnMarginMin: finite(Number(op.returnMarginMin)) ?? null,   // 戻る余裕(分)。未登録=null
    urgentPolicy: op.urgentPolicy === 'returnable' ? 'returnable' : 'stay', // 緊急: 離れない(既定) / 余裕を持って戻れるなら可
    // 🔧 設備の解放時点(第三者 2026-09-23): 'finish'=終了対応が済むまで押さえる(品物が載ったまま・既定・安全側) / 'autoEnd'=自動の終わりで空く
    equipmentHold: op.equipmentHold === 'autoEnd' ? 'autoEnd' : 'finish',
    // 🚶 往復が未登録の組: 'count'=足さず数える(結果は暫定・既定) / 'exclude'=その移動を伴う応援を割り付けない
    unknownTravel: op.unknownTravel === 'exclude' ? 'exclude' : 'count',
  };
};

export const travelKey = (a, b) => [str(a), str(b)].sort().join('|');
/** 片道の分数(登録)。無ければ null。 */
export const travelMinutesOf = (cfg, zoneA, zoneB) => {
  if (!zoneA || !zoneB) return null;
  if (zoneA === zoneB) return 0;
  const v = cfg && cfg.travelMin ? cfg.travelMin[travelKey(zoneA, zoneB)] : undefined;
  return Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null;
};

/**
 * ロットAの自動運転中の工程の「今」を組み立てる。
 * @param lot   検査リストのロット(steps・tasks・mapZoneId)
 * @param stepId 自動運転の工程 id
 * @param unitIndex 台(0始まり)。ロット1回の工程なら null
 * @param nowMs 基準時刻
 * @param cfg  readParallelLabConfig の戻り
 * @returns {{ ok:boolean, lotId, stepId, unitIndex, zoneId, title, autoTotalMs, autoStartMs, autoRemainingMs, finishWorkMs, mayLeave, missing:string[], source:{auto:'autoEndSec'|null, remaining:'batchStartedAt'|'startTime'|null} }}
 */
export function buildPhaseProfile({ lot, stepId, unitIndex = null, nowMs, cfg }) {
  const missing = [];
  const step = (isObj(lot) && Array.isArray(lot.steps) ? lot.steps : []).find((s) => isObj(s) && str(s.id) === str(stepId)) || null;
  const title = step ? str(step.title) : str(stepId);
  if (!step) missing.push(`工程 ${str(stepId)} がロットに無い`);
  if (step && !isAutoStep(step)) missing.push(`「${title}」は自動運転の工程ではない`);
  const autoSec = step ? Number(step.autoEndSec) : 0;
  const autoTotalMs = Number.isFinite(autoSec) && autoSec > 0 ? autoSec * 1000 : null;
  if (step && autoTotalMs == null) missing.push(`「${title}」の自動の時間(autoEndSec)が未登録`);
  const taskKey = unitIndex == null ? str(stepId) : `${str(stepId)}-${unitIndex}`;
  const task = isObj(lot) && isObj(lot.tasks) ? lot.tasks[taskKey] : null;
  const started = task ? (finite(task.batchStartedAt) ?? finite(task.startTime) ?? null) : null;
  const source = { auto: autoTotalMs != null ? 'autoEndSec' : null, remaining: task && finite(task.batchStartedAt) != null ? 'batchStartedAt' : (started != null ? 'startTime' : null) };
  if (started == null) missing.push(`「${title}」は自動運転が始まっていない(記録に開始時刻が無い)`);
  const autoRemainingMs = autoTotalMs != null && started != null ? Math.max(0, started + autoTotalMs - nowMs) : null;
  const fw = cfg && cfg.finishWorkMin ? cfg.finishWorkMin[str(stepId)] : undefined;
  const finishWorkMs = Number.isFinite(Number(fw)) && fw !== '' && fw !== null && fw !== undefined ? Number(fw) * 60000 : null;
  if (finishWorkMs == null) missing.push(`「${title}」の終了後の人の対応(分)が未登録`);
  const ml = cfg && cfg.mayLeave ? cfg.mayLeave[str(stepId)] : undefined;
  const mayLeave = ml === true ? true : ml === false ? false : null;
  if (mayLeave == null) missing.push(`「${title}」を離れてよいか(監視・即時対応の要否)が未登録`);
  return {
    ok: missing.length === 0, lotId: isObj(lot) ? str(lot.id) : '', stepId: str(stepId), unitIndex, zoneId: isObj(lot) ? str(lot.mapZoneId) : '',
    title, autoTotalMs, autoStartMs: started, autoRemainingMs, finishWorkMs, mayLeave, missing, source,
  };
}

/**
 * ロットBの候補の仕事(手作業)を組み立てる。所要は呼ぶ側が渡す(実測P75 か テンプレ目標。出典を必ず付ける)。
 * @returns {{ ok, lotId, stepId, unitIndex, zoneId, title, workMs, workSource, interruptible, missing:string[] }}
 */
export function buildCandidateJob({ lot, stepId, unitIndex = null, workMs, workSource, cfg }) {
  const missing = [];
  const step = (isObj(lot) && Array.isArray(lot.steps) ? lot.steps : []).find((s) => isObj(s) && str(s.id) === str(stepId)) || null;
  const title = step ? str(step.title) : str(stepId);
  if (!step) missing.push(`工程 ${str(stepId)} がロットに無い`);
  // 🚨 第三者(2026-09-23)④: 自動運転の工程を「Bの手作業」として受け入れない(人が手を動かす仕事だけ)
  if (step && isAutoStep(step)) missing.push(`「${title}」は自動運転の工程なので手作業の候補にしない`);
  if (!(Number.isFinite(workMs) && workMs > 0)) missing.push(`「${title}」の所要時間が無い`);
  if (!workSource) missing.push(`「${title}」の所要時間の出典が無い`);
  const ir = cfg && cfg.interruptible ? cfg.interruptible[str(stepId)] : undefined;
  const interruptible = ir === true;   // 未登録=中断できない(安全側)
  return { ok: missing.length === 0, lotId: isObj(lot) ? str(lot.id) : '', stepId: str(stepId), unitIndex, zoneId: isObj(lot) ? str(lot.mapZoneId) : '', title, workMs: finite(workMs), workSource: str(workSource), interruptible, missing };
}
