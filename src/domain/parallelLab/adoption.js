// =============================================================================
//  parallelLab/adoption.js — 比較して決めた条件を「採用」して本番の割付へ渡す／戻す(純関数)。2026-09-23
// -----------------------------------------------------------------------------
//  流れ(第三者 2026-09-23): 不足条件を確認 → 全体で比較 → 悪化するロットを確認 → 採用する条件を保存 → 現場へ提示
//  採用の記録に残す物: 対象の型式・テンプレ・工程／離席可否／終了対応時間／移動時間／設備の解放時点／
//    比較に使ったデータの時点と待機案との差／適用開始日時／採用した版(id)／元へ戻す操作(revert)。
//  保存先: settings.opsim.parallelLabAdoption = { current: record|null, history: [record…(新しい順・上限20)] }
//  🚨 本番の割付は current が在り enabled の時だけ scenario.parallelLab を受け取る(adoptedScenarioOf)。
//  🚨 暫定(往復が未登録)の比較からは採用できない(採用の前に登録するか除外で引き直す)。
// =============================================================================
import { isAutoStep } from '../workExecution.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const HISTORY_MAX = 20;
/** 版の id は現場の時計(ローカル)で。UTC だと「9/23 01:09 に採用した版が 0922T16…」になり読み違える */
const stampOf = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

/** settings から採用の状態を読む。無ければ空。 */
export const readAdoption = (settings) => {
  const ad = isObj(settings) && isObj(settings.opsim) && isObj(settings.opsim.parallelLabAdoption) ? settings.opsim.parallelLabAdoption : {};
  return { current: isObj(ad.current) ? ad.current : null, history: Array.isArray(ad.history) ? ad.history.filter(isObj) : [] };
};

/**
 * 比較に使った「条件＋対象」の指紋。比較の後に条件かデータが変わったら採用の門を閉じる(古い比較を根拠に新しい条件を保存しない)。
 * 🚨 第三者(2026-09-23)①。条件(settings.opsim.parallelLab の全部)とロット(id・テンプレ・型式・自動工程 id)を字にして短い数へ。
 */
export function adoptionFingerprint({ cfg, lots = [] }) {
  const c = cfg || {};
  const lotPart = lots.filter(isObj).map((l) => `${str(l.id)}:${str(l.templateId)}:${str(l.model)}:${str(l.mapZoneId)}:${(Array.isArray(l.steps) ? l.steps : []).filter((s) => isObj(s) && isAutoStep(s)).map((s) => str(s.id)).join(',')}`).sort().join('|');
  const text = JSON.stringify({ mayLeave: c.mayLeave, finishWorkMin: c.finishWorkMin, travelMin: c.travelMin, returnMarginMin: c.returnMarginMin ?? null, urgentPolicy: c.urgentPolicy, equipmentHold: c.equipmentHold, unknownTravel: c.unknownTravel, interruptible: c.interruptible }) + '#' + lotPart;
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return `${h.toString(16)}-${lots.length}`;
}

/**
 * 採用できるかを先に言う(理由を名指し)。
 * @param stale 比較した時の指紋と今の指紋が違う(条件かデータが変わった)
 * @returns {{ ok:boolean, reasons:string[] }}
 */
export function adoptionBlockers({ whole, scenario, stale = false }) {
  const reasons = [];
  if (!whole || !whole.ok) reasons.push('全体で比べた結果がありません（先に「🌐 全体で比べる」）');
  if (stale) reasons.push('比較の後に 条件か検査リストが変わりました。この条件で「🌐 全体で比べる」をやり直してから採用してください');
  if (whole && whole.provisional) reasons.push(`時間を足していない移動が ${(whole.delta.travelUnknown || 0) + (whole.delta.zoneUnknown || 0)}回あり結果が暫定です（場所と往復を登録するか「未登録の移動を伴う応援は除外」で引き直す）`);
  if (whole && whole.ok && whole.delta.becameUnfinished > 0) reasons.push(`応援で期間内に終わらなくなるロットが ${whole.delta.becameUnfinished}件あります（納期超過の数には入っていません）`);
  if (scenario && Object.keys(scenario.autoSteps || {}).length === 0) reasons.push('条件(離れてよい・終了対応)が登録された自動工程が 0件です');
  return { ok: reasons.length === 0, reasons };
}

/**
 * 採用の記録を組む(保存はしない)。
 * @param cfg        readParallelLabConfig の戻り
 * @param scenario   buildParallelLabScenario の scenario
 * @param lots       検査リスト(対象の型式・テンプレ・工程を書き出す)
 * @param whole      compareWholePlans の戻り
 * @param dataAtMs   比較に使ったデータの時点(検査リストを読んだ時刻)
 * @param nowMs      採用した時刻
 * @param applyFromMs 適用開始日時(既定=いま)
 * @param by         採用した人(任意)
 */
export function buildAdoptionRecord({ cfg, scenario, lots = [], whole, dataAtMs, nowMs, applyFromMs = null, by = '' }) {
  const stepTitle = new Map();
  const targets = new Map();   // stepId → { stepId, title, models:Set, templateIds:Set, lots:number }
  for (const key of Object.keys(scenario && scenario.autoSteps ? scenario.autoSteps : {})) {
    const [lotId, stepId] = key.split('|');
    const lot = lots.find((l) => isObj(l) && str(l.id) === lotId);
    const step = lot && Array.isArray(lot.steps) ? lot.steps.find((s) => isObj(s) && str(s.id) === stepId) : null;
    if (step) stepTitle.set(stepId, str(step.title));
    const t = targets.get(stepId) || { stepId, title: stepTitle.get(stepId) || stepId, models: new Set(), templateIds: new Set(), lots: 0 };
    if (lot) { if (lot.model) t.models.add(str(lot.model)); if (lot.templateId) t.templateIds.add(str(lot.templateId)); t.lots += 1; }
    targets.set(stepId, t);
  }
  const id = `pl-${stampOf(nowMs)}`;
  return {
    id, kind: 'adopt', enabled: true,
    adoptedAtMs: nowMs, applyFromMs: Number.isFinite(applyFromMs) ? applyFromMs : nowMs, by: str(by),
    conditions: {
      steps: [...targets.values()].map((t) => ({ stepId: t.stepId, title: t.title, mayLeave: true, finishWorkMin: Number(cfg.finishWorkMin[t.stepId]), models: [...t.models].sort(), templateIds: [...t.templateIds].sort(), lots: t.lots })),
      travelMin: { ...(cfg.travelMin || {}) },
      returnMarginMin: cfg.returnMarginMin ?? null,
      equipmentHold: scenario.equipmentHold, unknownTravel: scenario.unknownTravel, urgentPolicy: cfg.urgentPolicy,
    },
    fingerprint: adoptionFingerprint({ cfg, lots }),
    basis: {
      dataAtMs: Number.isFinite(dataAtMs) ? dataAtMs : nowMs, lots: lots.length,
      stayLate: whole.delta.stayLate, releaseLate: whole.delta.releaseLate, lateMs: whole.delta.lateMs,
      earlier: whole.delta.earlier, later: whole.delta.later, crossedLate: whole.delta.crossedLate, released: whole.delta.released,
      equipmentHeldMs: whole.delta.equipmentHeldMs, stayUnfinished: whole.delta.stayUnfinished, releaseUnfinished: whole.delta.releaseUnfinished, worst: whole.perLot.slice(0, 5).map((p) => ({ lotId: p.lotId, deltaMs: p.deltaMs, slackReleaseMs: p.slackReleaseMs })),
    },
    revertOf: null,
  };
}

/** 採用を settings へ入れる形(current を置き、履歴の先頭へ)。 */
export function applyAdoption(adoption, record) {
  const prev = readAdoption({ opsim: { parallelLabAdoption: adoption } });
  return { current: record, history: [record, ...prev.history].slice(0, HISTORY_MAX) };
}

/** 元へ戻す: current を外し、戻した記録を履歴へ。 */
export function revertAdoption(adoption, nowMs, by = '') {
  const prev = readAdoption({ opsim: { parallelLabAdoption: adoption } });
  if (!prev.current) return { current: null, history: prev.history };
  const rec = { id: `pl-revert-${stampOf(nowMs)}`, kind: 'revert', enabled: false, adoptedAtMs: nowMs, by: str(by), revertOf: prev.current.id, conditions: prev.current.conditions, basis: prev.current.basis };
  return { current: null, history: [rec, ...prev.history].slice(0, HISTORY_MAX) };
}

/**
 * 本番の割付へ渡す scenario.parallelLab。採用が無い／適用前／無効なら null(=今までの計算と1バイトも同じ)。
 * 🚨 採用の記録に書いた条件だけ(その後 settings.opsim.parallelLab を触っても、採用し直すまで効かない)。
 */
export function adoptedScenarioOf({ settings, lots = [], nowMs }) {
  const { current } = readAdoption(settings);
  if (!current || current.enabled !== true || !isObj(current.conditions)) return null;
  if (Number.isFinite(current.applyFromMs) && nowMs < current.applyFromMs) return null;
  const byStep = new Map((current.conditions.steps || []).map((s) => [str(s.stepId), s]));
  const autoSteps = {};
  for (const l of lots) {
    if (!isObj(l)) continue;
    for (const s of (Array.isArray(l.steps) ? l.steps : [])) {
      const c = isObj(s) ? byStep.get(str(s.id)) : null;
      if (!c || c.mayLeave !== true || !(Number(c.finishWorkMin) > 0)) continue;
      // 🚨 第三者(2026-09-23)②: 工程 id だけで広げない。比較した テンプレ(無ければ型式)の範囲だけ・適用時にも自動運転か確かめる
      if (!isAutoStep(s)) continue;
      const tpls = Array.isArray(c.templateIds) ? c.templateIds : []; const models = Array.isArray(c.models) ? c.models : [];
      const inScope = str(l.templateId) ? tpls.includes(str(l.templateId)) : (!!str(l.model) && models.includes(str(l.model)));
      if (!inScope) continue;
      autoSteps[`${str(l.id)}|${str(s.id)}`] = { mayLeave: true, finishWorkMin: Number(c.finishWorkMin) };
    }
  }
  if (Object.keys(autoSteps).length === 0) return null;
  const cd = current.conditions;
  return { release: true, autoSteps, travelMin: isObj(cd.travelMin) ? cd.travelMin : {}, equipmentHold: cd.equipmentHold === 'autoEnd' ? 'autoEnd' : 'finish', unknownTravel: cd.unknownTravel === 'exclude' ? 'exclude' : 'count', returnMarginMin: Number.isFinite(Number(cd.returnMarginMin)) && cd.returnMarginMin !== null ? Number(cd.returnMarginMin) : null, urgentPolicy: cd.urgentPolicy === 'returnable' ? 'returnable' : 'stay', adoptionId: current.id };
}

/**
 * 現場へ見せる形: 本番の結果(assignments)から「いま B を進める／何時までに A へ戻る／予定が外れたら」を人ごとに組む。
 * 終了対応(#finish)の割付が 解放の証拠(同じ人・afterJobId=自動)。
 * @returns {[{ worker, aLotId, aJobId, autoStartMs, autoEndMs, returnByMs, finishStartMs, finishEndMs, during:[{jobId, lotId, startMs, endMs}], waitAfterAutoMs, ifLate:string[] }]}
 */
export function fieldInstructionsOf({ simResult, conditions, nowMs }) {
  // 🚨 第三者(2026-09-23)④: 現場の指示は **採用した版の条件** だけから(ラボで編集中の設定は見ない)
  const cfg = isObj(conditions) ? conditions : {};
  const rows = simResult && Array.isArray(simResult.assignments) ? simResult.assignments : [];
  const byId = new Map(rows.map((a) => [str(a.jobId), a]));
  const out = [];
  for (const fin of rows) {
    const id = str(fin.jobId);
    if (!id.endsWith('#finish')) continue;
    const auto = byId.get(id.slice(0, -'#finish'.length));
    if (!auto) continue;
    if (Number.isFinite(nowMs) && fin.endMs < nowMs) continue;   // もう済んだ物は出さない
    const during = rows.filter((a) => a.worker === fin.worker && str(a.jobId) !== id && a.startMs >= auto.startMs && a.startMs < fin.startMs && str(a.lotId) !== str(auto.lotId))
      .sort((x, y) => x.startMs - y.startMs).map((a) => ({ jobId: str(a.jobId), lotId: str(a.lotId), startMs: a.startMs, endMs: a.endMs }));
    const margin = Number.isFinite(Number(cfg.returnMarginMin)) && cfg.returnMarginMin !== null ? Number(cfg.returnMarginMin) * 60000 : 0;
    const hold = cfg.equipmentHold !== 'autoEnd';
    out.push({
      worker: str(fin.worker), aLotId: str(auto.lotId), aJobId: str(auto.jobId),
      autoStartMs: auto.startMs, autoEndMs: auto.endMs, returnByMs: Math.max(auto.startMs, auto.endMs - margin), finishStartMs: fin.startMs, finishEndMs: fin.endMs,
      during, waitAfterAutoMs: Math.max(0, fin.startMs - auto.endMs),   // 自動が終わってから人が戻るまでの品物の待ち
      ifLate: [
        `自動が早く終わっても、${hold ? '品物は載ったまま・設備は押さえているので次のロットは入らない' : '設備は空くので次のロットが入る（品物を先に外す）'}`,
        `手作業が長引いたら ${margin ? `${cfg.returnMarginMin}分前` : '予定の終わり'} には戻る（戻れないなら別の人に終了対応を頼む）`,
        '緊急が来たら ' + (cfg.urgentPolicy === 'returnable' ? '余裕を持って戻れる範囲で応援' : '離れない（先に緊急を片付ける）'),
      ],
    });
  }
  return out.sort((x, y) => x.autoEndMs - y.autoEndMs);
}
