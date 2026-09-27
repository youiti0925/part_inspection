// =============================================================================
//  parallelLab/wholePlan.js — 全体再計算の材料と採点(純関数)。2026-09-22 深夜／09-23 第三者の3点
// -----------------------------------------------------------------------------
//  ラボの画面が 本物のエンジン(runLadderRung → runOperationsSimulationPipeline)を2回回す:
//    待機 = 今の scenario / 応援 = 同じ scenario + parallelLab(自動中の人だけ解放・設備は占有・終了対応・往復)。
//  ここは (1) 条件から scenario.parallelLab を作る (2) 2つの結果を同じ物差しで並べる だけ。数字を作らない。
//  🚨 本番適用は「採用」した条件だけ(adoption.js)。ここで作る scenario は ラボの画面が渡す。
//  📐 第三者(2026-09-23): 往復が未登録の結果は **暫定**(足していない分だけ楽)／設備の解放時点を明記／
//     遅くなるロットは「何分遅くなり・納期の余裕が何分残るか」まで出す。
// =============================================================================
import { isAutoStep } from '../workExecution.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (v == null ? '' : String(v));
const min = (ms) => Math.round(ms / 60000);
/** 分を「3時間20分」の字に。負は「−」。 */
export const hmText = (ms) => {
  const neg = ms < 0; const m = Math.abs(min(ms)); const h = Math.floor(m / 60);
  return `${neg ? '−' : ''}${h ? `${h}時間` : ''}${m % 60 || !h ? `${m % 60}分` : ''}`;
};

/**
 * 登録した条件(settings.opsim.parallelLab)と検査リストから scenario.parallelLab を作る。
 * autoSteps は「ロット|工程」ごと。離れてよい(mayLeave)と終了対応(finishWorkMin)が **両方登録** された自動工程だけ載る。
 * 待機の土俵(stayScenario)は同じ条件で holdWorker:true(人は離れない・終了対応と設備の押さえは同じ)。土俵を揃えないと応援が構造的に遅く見える。
 * @returns {{ scenario:{release:true, autoSteps, travelMin, equipmentHold, unknownTravel}, stayScenario:{...同じ, holdWorker:true}, counted:{autoSteps, eligible, lotsWithZone, lotsWithoutZone} }}
 */
export function buildParallelLabScenario({ lots = [], cfg }) {
  const autoSteps = {};
  let autoCount = 0, eligible = 0, withZone = 0, withoutZone = 0;
  for (const l of lots) {
    if (!isObj(l)) continue;
    if (str(l.mapZoneId)) withZone += 1; else withoutZone += 1;
    for (const s of (Array.isArray(l.steps) ? l.steps : [])) {
      if (!isObj(s) || !isAutoStep(s)) continue;
      autoCount += 1;
      const ml = cfg && cfg.mayLeave ? cfg.mayLeave[str(s.id)] : undefined;
      const fw = cfg && cfg.finishWorkMin ? cfg.finishWorkMin[str(s.id)] : undefined;
      if (ml === true && Number(fw) > 0) { autoSteps[`${str(l.id)}|${str(s.id)}`] = { mayLeave: true, finishWorkMin: Number(fw) }; eligible += 1; }
    }
  }
  const scenario = {
    release: true, autoSteps,
    travelMin: (cfg && isObj(cfg.travelMin)) ? cfg.travelMin : {},
    equipmentHold: cfg && cfg.equipmentHold === 'autoEnd' ? 'autoEnd' : 'finish',
    unknownTravel: cfg && cfg.unknownTravel === 'exclude' ? 'exclude' : 'count',
    // 🚨 第三者(2026-09-23)③: 戻る余裕・緊急の扱い も全体計算へ渡す(局所の3案だけで効いても全体で守られない)
    returnMarginMin: cfg && Number.isFinite(Number(cfg.returnMarginMin)) && cfg.returnMarginMin !== null ? Number(cfg.returnMarginMin) : null,
    urgentPolicy: cfg && cfg.urgentPolicy === 'returnable' ? 'returnable' : 'stay',
  };
  return {
    scenario,
    stayScenario: { ...scenario, holdWorker: true },
    counted: { autoSteps: autoCount, eligible, lotsWithZone: withZone, lotsWithoutZone: withoutZone },
  };
}

const rowsOf = (base) => {
  const rows = (base && Array.isArray(base.lotResults)) ? base.lotResults : [];
  let late = 0, lateMs = 0, unfinished = 0;
  const byLot = new Map();
  for (const r of rows) {
    const f = Number.isFinite(r.finishMs) ? r.finishMs : (Number.isFinite(r.lastEndMs) ? r.lastEndMs : null);
    const due = Number.isFinite(r.dueMs) ? r.dueMs : (Number.isFinite(r.dueLineMs) ? r.dueLineMs : null);
    byLot.set(str(r.lotId), { finishMs: f, dueMs: due });
    // 🚨 第三者(2026-09-23)①: 終了時刻が無い(期間内に終わらない)ロットを「遅れ 0」と数えない。別に数えて必ず言う
    if (f == null) { unfinished += 1; continue; }
    if (due != null && f > due) { late += 1; lateMs += f - due; }
  }
  return { late, lateMs, unfinished, byLot };
};

/**
 * 2つの結果(待機 stay / 応援 release)を同じ物差しで並べる。
 * @returns {{ ok, provisional:boolean, lines:string[], delta, perLot:[{lotId, stayMs, releaseMs, deltaMs, dueMs, slackStayMs, slackReleaseMs, crossed}] }}
 *   crossed: 'late'=待機では間に合っていたのに応援で納期超過 / 'saved'=その逆 / null
 */
export function compareWholePlans({ stay, release, lotLabel = (id) => id } = {}) {
  if (!stay || !release) return { ok: false, provisional: false, lines: ['全体再計算の結果が2つ揃っていません'], delta: null, perLot: [] };
  const a = rowsOf(stay), b = rowsOf(release);
  const perLot = [];
  let earlier = 0, later = 0, crossedLate = 0, crossedSaved = 0;
  let becameUnfinished = 0, becameFinished = 0;
  for (const [lotId, s] of a.byLot) {
    const r = b.byLot.get(lotId);
    if (!r) continue;
    // 終わっていた物が応援で終わらなくなった(またはその逆)は「変化」として必ず数える(消さない)
    if (s.finishMs != null && r.finishMs == null) { becameUnfinished += 1; later += 1; perLot.push({ lotId, stayMs: s.finishMs, releaseMs: null, deltaMs: Infinity, dueMs: s.dueMs, slackStayMs: s.dueMs == null ? null : s.dueMs - s.finishMs, slackReleaseMs: null, crossed: 'unfinished' }); continue; }
    if (s.finishMs == null && r.finishMs != null) { becameFinished += 1; earlier += 1; perLot.push({ lotId, stayMs: null, releaseMs: r.finishMs, deltaMs: -Infinity, dueMs: r.dueMs, slackStayMs: null, slackReleaseMs: r.dueMs == null ? null : r.dueMs - r.finishMs, crossed: 'finished' }); continue; }
    if (s.finishMs == null || r.finishMs == null) continue;
    const d = r.finishMs - s.finishMs;
    if (d < 0) earlier += 1; else if (d > 0) later += 1;
    if (d === 0) continue;
    const dueMs = s.dueMs ?? r.dueMs ?? null;
    const slackStayMs = dueMs == null ? null : dueMs - s.finishMs;
    const slackReleaseMs = dueMs == null ? null : dueMs - r.finishMs;
    const crossed = dueMs == null ? null : (slackStayMs >= 0 && slackReleaseMs < 0) ? 'late' : (slackStayMs < 0 && slackReleaseMs >= 0) ? 'saved' : null;
    if (crossed === 'late') crossedLate += 1; else if (crossed === 'saved') crossedSaved += 1;
    perLot.push({ lotId, stayMs: s.finishMs, releaseMs: r.finishMs, deltaMs: d, dueMs, slackStayMs, slackReleaseMs, crossed });
  }
  // 並び: 納期を跨いで遅れる物 → 遅くなる物(大きい順) → 早くなる物
  perLot.sort((x, y) => (Number(y.crossed === 'unfinished') - Number(x.crossed === 'unfinished')) || (Number(y.crossed === 'late') - Number(x.crossed === 'late')) || (Number(y.deltaMs > 0) - Number(x.deltaMs > 0)) || (Math.abs(y.deltaMs) - Math.abs(x.deltaMs)));
  const st = release.parallelLabStats || { released: 0, travelAdded: 0, travelUnknown: 0, zoneUnknown: 0, excluded: 0, equipmentHeldMs: 0 };
  // ③ 往復が未登録(組の分数が無い)でも、場所そのものが未登録でも、時間を足していない=暫定
  const provisional = Number(st.travelUnknown) > 0 || Number(st.zoneUnknown) > 0;
  const sign = (n) => (n >= 0 ? '+' : '');
  const slackText = (p) => (p.crossed === 'unfinished' ? '期間内に終わらなくなる' : p.crossed === 'finished' ? '期間内に終わるようになる' : p.dueMs == null ? '納期の登録なし' : `納期まで ${hmText(p.slackStayMs)} → ${hmText(p.slackReleaseMs)}`);
  const deltaText = (p) => (p.crossed === 'unfinished' ? '終わらない' : p.crossed === 'finished' ? '終わる' : `${p.deltaMs < 0 ? '−' : '+'}${min(Math.abs(p.deltaMs))}分`);
  const lines = [
    `納期超過のロット: 待機 ${a.late}件 → 応援 ${b.late}件（${sign(b.late - a.late)}${b.late - a.late}件）／超過の合計 ${sign(min(b.lateMs - a.lateMs))}${min(b.lateMs - a.lateMs)}分${crossedLate ? `／⚠ 応援で新たに納期を超えるロット ${crossedLate}件` : ''}${crossedSaved ? `／応援で納期に間に合うようになるロット ${crossedSaved}件` : ''}`,
    `期間内に終わらないロット: 待機 ${a.unfinished}件 → 応援 ${b.unfinished}件${becameUnfinished ? `（⚠ 応援で終わらなくなる ${becameUnfinished}件。上の納期超過には入っていない）` : ''}${becameFinished ? `（応援で終わるようになる ${becameFinished}件）` : ''}`,
    `早く終わるロット ${earlier}件／遅くなるロット ${later}件（自動中に人を解放した回数 ${st.released}・往復を足した回数 ${st.travelAdded}${st.travelUnknown ? `・往復が未登録で足せなかった回数 ${st.travelUnknown}` : ''}${st.zoneUnknown ? `・場所が未登録で足せなかった移動 ${st.zoneUnknown}回` : ''}${st.excluded ? `・未登録の移動を伴うので割り付けなかった仕事 ${st.excluded}件` : ''}${st.returnGated ? `・戻る余裕に収まらず取らなかった仕事 ${st.returnGated}件` : ''}${st.urgentKept ? `・緊急ロットなので離れなかった回数 ${st.urgentKept}` : ''}）`,
    `設備: ${release.parallelLabStats && Number(st.equipmentHeldMs) > 0 ? `品物が載ったまま(終了対応が済むまで)押さえた合計 ${hmText(st.equipmentHeldMs)}` : '自動の終わりで空く（終了対応まで押さえた時間 0分）'}`,
    ...(provisional ? [`⚠ 暫定: 時間を足していない移動が ${(Number(st.travelUnknown) || 0) + (Number(st.zoneUnknown) || 0)}回あります（往復の未登録 ${Number(st.travelUnknown) || 0}・場所の未登録 ${Number(st.zoneUnknown) || 0}。足せば応援は今より遅くなる側）。採用の前に 場所と往復を登録するか「未登録の移動を伴う応援は除外」で引き直してください`] : []),
    ...perLot.slice(0, 8).map((p) => `${lotLabel(p.lotId)}: ${deltaText(p)}（${slackText(p)}${p.crossed === 'late' ? '・⚠ 納期超過へ' : p.crossed === 'saved' ? '・納期に間に合う' : ''}）`),
  ];
  return {
    ok: true, provisional, lines, perLot: perLot.map((p) => ({ ...p, deltaText: deltaText(p), slackText: slackText(p) })),
    delta: { lateLots: b.late - a.late, lateMs: b.lateMs - a.lateMs, released: st.released, travelAdded: st.travelAdded, travelUnknown: Number(st.travelUnknown) || 0, zoneUnknown: Number(st.zoneUnknown) || 0, excluded: Number(st.excluded) || 0, equipmentHeldMs: Number(st.equipmentHeldMs) || 0, earlier, later, crossedLate, crossedSaved, stayLate: a.late, releaseLate: b.late, stayUnfinished: a.unfinished, releaseUnfinished: b.unfinished, becameUnfinished, becameFinished },
  };
}
