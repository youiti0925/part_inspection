// =============================================================================
//  parallelLab/juggling.js — 操業シミュの「1ロットずつ(既定)／掛け持ちあり」の切り替え(純関数)。2026-09-26
// -----------------------------------------------------------------------------
//  清水さん(2026-09-26)「納期一覧・操業シミュは 並列しない前提で1ロットずつの今までどおりでいい(来る時間が分からないから)。
//    基本は1ロットずつで、場合によって並列へ切り替えられるなら面白い」→「作って。その後本番」
//
//  ・既定 'off' = 今までの計算と1バイトも同じ(scenario に parallelLab を載せない)。
//  ・'on' = エンジンが既に持つ掛け持ちの計算(simulate.js の parallelLab: 自動中に人を解放・往復・終了対応・後続の納期まで再計算)へ、
//    入力を **自動で組んで** 渡す。前は「採用の門」(adoption.js)からしか渡らず、門を開ける登録(工程ごとの 離れてよい/終了対応・往復の表)が
//    本番には1件も無かった(2026-09-25 の控え)。
//  ・自動で組む入力の出どころ(数字を作らない・出どころを結果の横に出す):
//      自動工程 = isAutoStep の工程 全部(登録 settings.opsim.parallelLab.mayLeave[stepId]===false なら外す)
//                 【記録】実際の掛け持ち69回は 6分の分割測定・回転/傾斜・校正 の全部で起きている
//      終了対応 = 登録 finishWorkMin[stepId] が在ればそれ、無ければ 0.3分【記録】手で止めてから次の作業まで 中央値0.3分
//      片道    = 区画どうしの表(settings.opsim.zoneTravel.override・分)→ 同じ区画0 → 名前の目安(中間・完品どうし10秒/三次元・第一組立30秒【清水さん】)
//                 → 分からない組は入れない(エンジンが「未登録」と数えて暫定の印を出す)
//      戻る余裕 = 無し(清水さん: 固定の足切りは置かない)／緊急ロット = 戻れるなら離れてよい
//  ⚠ ここは製品だけ(最終検査の simulate.js には parallelLab が無い)。opsimRules.js(両アプリで同じ物)には入れない。
// =============================================================================
import { isAutoStep } from '../workExecution.js';
import { walkSecOf } from '../juggleGuide.js';
import { readParallelLabConfig } from './phaseProfile.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v)).trim();

export const JUGGLING_KEY = 'jugglingMode';
export const JUGGLING_CHOICES = Object.freeze([
  { key: 'off', label: '1ロットずつ（既定・今までどおり）' },
  { key: 'on', label: '掛け持ちあり（自動測定の間に別のロットへ行って戻る）' },
]);
/** 【記録】手で止めてから次の作業を押すまで 中央値0.3分(引き継ぎ資料 5.5)。登録が無い工程の終了対応に使う */
export const DEFAULT_FINISH_WORK_MIN = 0.3;

/** settings.opsim.jugglingMode → 'off' | 'on'。無ければ 'off' */
export const readJugglingMode = (settings) => {
  const v = settings && settings.opsim && settings.opsim[JUGGLING_KEY];
  return v === 'on' ? 'on' : 'off';
};

/**
 * 掛け持ちありの scenario.parallelLab を、検査リストと設定から組む。
 * @param {{ settings:object, lots:Array, zones?:Array, isAuto?:function }} p
 * @returns {{ scenario:object, counted:{ lots, autoSteps, autoStepsOff, lotsWithZone, lotsWithoutZone, pairs, pairsFromTable, pairsFromName, pairsUnknown }, basis:string[] }}
 */
export function jugglingScenarioOf({ settings = {}, lots = [], zones = null, isAuto = isAutoStep } = {}) {
  const cfg = readParallelLabConfig(settings);
  const zoneList = Array.isArray(zones) ? zones : (Array.isArray(settings && settings.mapZones) ? settings.mapZones : []);
  const travel = (settings && settings.opsim && settings.opsim.zoneTravel) || null;
  const autoSteps = {};
  let autoCount = 0, autoOff = 0, withZone = 0, withoutZone = 0, lotCount = 0;
  for (const l of lots) {
    if (!isObj(l) || !str(l.id || l.__id)) continue;
    if (l.status === 'completed' || l.location === 'completed') continue;
    lotCount += 1;
    if (str(l.mapZoneId)) withZone += 1; else withoutZone += 1;
    for (const s of (Array.isArray(l.steps) ? l.steps : [])) {
      if (!isObj(s) || !str(s.id) || !isAuto(s)) continue;
      autoCount += 1;
      const ml = cfg.mayLeave ? cfg.mayLeave[str(s.id)] : undefined;
      if (ml === false) { autoOff += 1; continue; }
      const fw = cfg.finishWorkMin ? Number(cfg.finishWorkMin[str(s.id)]) : NaN;
      autoSteps[`${str(l.id || l.__id)}|${str(s.id)}`] = { mayLeave: true, finishWorkMin: Number.isFinite(fw) && fw > 0 ? fw : DEFAULT_FINISH_WORK_MIN };
    }
  }
  // 区画どうしの片道(分)。エンジンの鍵は [a,b].sort().join('|')。登録の表(parallelLab.travelMin)が在ればそれが先
  const travelMin = {};
  let pairs = 0, fromTable = 0, fromName = 0, unknown = 0;
  const ids = zoneList.filter((z) => z && str(z.id) && str(z.id) !== 'zone_unassigned').map((z) => str(z.id));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      pairs += 1;
      const key = [ids[i], ids[j]].sort().join('|');
      const reg = cfg.travelMin ? Number(cfg.travelMin[key]) : NaN;
      if (Number.isFinite(reg) && reg >= 0) { travelMin[key] = reg; fromTable += 1; continue; }
      const w = walkSecOf({ a: ids[i], b: ids[j], zones: zoneList, travel });
      if (w.sec == null) { unknown += 1; continue; }
      travelMin[key] = Math.round((w.sec / 60) * 10000) / 10000;
      if (w.source === 'table') fromTable += 1; else fromName += 1;
    }
  }
  const scenario = {
    release: true, autoSteps, travelMin,
    equipmentHold: 'finish', unknownTravel: 'count', returnMarginMin: null, urgentPolicy: 'returnable',
    source: 'juggling',
  };
  const counted = { lots: lotCount, autoSteps: autoCount, autoStepsOff: autoOff, lotsWithZone: withZone, lotsWithoutZone: withoutZone, pairs, pairsFromTable: fromTable, pairsFromName: fromName, pairsUnknown: unknown };
  const basis = [
    `自動工程 ${autoCount - autoOff}件で人を離す(${lotCount}ロット・登録で「離れない」にした工程 ${autoOff}件)。終了対応は 登録が無ければ 0.3分【記録: 手で止めてから次の作業まで 中央値0.3分】`,
    `片道: 区画の組 ${pairs}のうち 表から ${fromTable}・名前の目安(10秒/30秒【清水さん 09-26】)から ${fromName}・分からない ${unknown}(足さずに数える=暫定)`,
    `場所の登録: 有り ${withZone}ロット／無し ${withoutZone}ロット(無い物は移動0分で数える=暫定)`,
    '戻る余裕の足切りは無し。緊急ロットは戻れるなら離れてよい。設備は終了対応が済むまで押さえる',
  ];
  return { scenario, counted, basis };
}
