// 🤝 2026-09-04: Codex の枝 origin/codex/opsim-decision-board-20260903 (13bb9d2) から純関数と試験だけを接いだ。
//   決まり14-3「スキルが無い → どの記録があれば何件渡せるか」の答え＝空いた人に工程を **仮に持たせて割付を引き直す**。
//   ⚠ Worker への配線(skillTrials・1人1件・最大4件)は operationsSimulation.worker.js 側。この担当のファイルではないので親が接ぐ。
//   ⚠ DecisionBoard.jsx(画面)は持ち込まない(清水さんが別の住所で見比べる)。
// 操業シミュレーションの「割付と空き」画面へ渡す材料を作る純関数。
// React / Firebase / 現在時刻は読まない。同じ結果からは同じ候補を返す。

import { IDLE_REASON, UNRESOLVED_REASON } from './simulate.js';

const MINUTE_MS = 60000;
const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const text = (value) => (value == null ? '' : String(value).trim());
const finite = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const cmp = (a, b) => (a === b ? 0 : (a < b ? -1 : 1));

const overlapMs = (a0, a1, b0, b1) => {
  const from = Math.max(a0, b0);
  const to = Math.min(a1, b1);
  return Math.max(0, to - from);
};

const lateLotIdsOf = (result) => new Set(asArray(result && result.lotResults)
  .filter((row) => row && row.late === true)
  .map((row) => text(row.lotId))
  .filter(Boolean));

/**
 * 「納期に間に合うかを判定できたロット」の集合。
 * 🚨 欄名は simulate.js の buildLotResults が付ける `judgeable`(真偽)。実物を読んで確かめた
 *   (2026-09-07 実測: simulate.js の buildLotResults が `judgeable` と `unknownReason` を押す)。
 *   納期が無い／入力が足りなくて終わりの時刻が出せない、が judgeable:false。
 * ⚠ 欄が無い古い形は「判定できた」として数える(!== false)。無い物を勝手に false にしない。
 */
const judgeableLotIdsOf = (result) => new Set(asArray(result && result.lotResults)
  .filter((row) => row && row.judgeable !== false)
  .map((row) => text(row.lotId))
  .filter(Boolean));

const lotIdsOf = (result) => new Set(asArray(result && result.lotResults)
  .map((row) => text(row && row.lotId))
  .filter(Boolean));

const unresolvedJobIdsOf = (result) => new Set(asArray(result && result.unresolved)
  .map((row) => text(row && row.jobId))
  .filter(Boolean));

const assignedJobIdsOf = (result, worker) => new Set(asArray(result && result.assignments)
  .filter((row) => text(row && row.worker) === worker || text(row && row.partner) === worker)
  .map((row) => text(row.jobId))
  .filter(Boolean));

export function skillIdleMsOf(result, worker) {
  const who = text(worker);
  return asArray(result && result.idleLog).reduce((sum, row) => {
    if (text(row && row.worker) !== who || text(row && row.reason) !== IDLE_REASON.NO_SKILL_MATCH) return sum;
    const from = finite(row.fromMs);
    const to = finite(row.toMs);
    return sum + (from != null && to != null ? Math.max(0, to - from) : 0);
  }, 0);
}

/**
 * 「技能の当てが無い」で空いた区間と、その時に他の人へ渡った仕事を突き合わせる。
 * 候補は1人2工程まで、全体6件まで。並びは遅れ→納期→空きとの重なりで固定する。
 */
export function buildSkillTrialCandidates({ base, normalized, maxTrials = 6, maxPerWorker = 2 } = {}) {
  const jobs = asArray(normalized && normalized.jobs);
  const lots = asArray(normalized && normalized.lots);
  const jobById = new Map(jobs.map((job) => [text(job.jobId), job]));
  const lotById = new Map(lots.map((lot) => [text(lot.lotId), lot]));
  const lateLots = lateLotIdsOf(base);
  const idleRows = asArray(base && base.idleLog)
    .filter((row) => text(row.reason) === IDLE_REASON.NO_SKILL_MATCH)
    .map((row) => ({
      worker: text(row.worker),
      fromMs: finite(row.fromMs),
      toMs: finite(row.toMs),
    }))
    .filter((row) => row.worker && row.fromMs != null && row.toMs != null && row.toMs > row.fromMs);

  const candidates = new Map();
  const add = ({ worker, job, overlap = 0, source }) => {
    const processKey = text(job && job.processKey);
    const jobId = text(job && job.jobId);
    const lotId = text(job && job.lotId);
    if (!worker || !processKey || !jobId) return;
    const lot = lotById.get(lotId) || null;
    const dueLineMs = finite(lot && lot.dueLineMs);
    const key = `${worker}\u0000${processKey}`;
    const next = {
      worker,
      processKey,
      processTitle: text(job.title) || text(lot && asArray(lot.steps).find((step) => text(step.processKey) === processKey)?.title),
      jobId,
      lotId,
      model: text(job.model) || text(lot && lot.model),
      templateId: text(lot && lot.templateId),
      dueLineMs,
      late: lateLots.has(lotId),
      overlapMs: Math.max(0, overlap),
      source,
    };
    const old = candidates.get(key);
    if (!old
      || Number(next.late) > Number(old.late)
      || (next.late === old.late && (next.dueLineMs ?? Infinity) < (old.dueLineMs ?? Infinity))
      || (next.late === old.late && next.dueLineMs === old.dueLineMs && next.overlapMs > old.overlapMs)) {
      candidates.set(key, next);
    }
  };

  idleRows.forEach((idle) => {
    asArray(base && base.assignments).forEach((assignment) => {
      if (text(assignment.worker) === idle.worker || text(assignment.partner) === idle.worker) return;
      const from = finite(assignment.startMs);
      const to = finite(assignment.endMs);
      if (from == null || to == null) return;
      const overlap = overlapMs(idle.fromMs, idle.toMs, from, to);
      if (overlap <= 0) return;
      add({ worker: idle.worker, job: jobById.get(text(assignment.jobId)), overlap, source: 'other-assignment' });
    });

    asArray(base && base.unresolved).forEach((row) => {
      if (text(row.reason) !== UNRESOLVED_REASON.NO_CANDIDATE) return;
      add({
        worker: idle.worker,
        job: jobById.get(text(row.jobId)),
        overlap: idle.toMs - idle.fromMs,
        source: 'unresolved',
      });
    });
  });

  const ordered = [...candidates.values()].sort((a, b) => (
    Number(b.late) - Number(a.late)
    || ((a.dueLineMs ?? Infinity) - (b.dueLineMs ?? Infinity))
    || (b.overlapMs - a.overlapMs)
    || cmp(a.worker, b.worker)
    || cmp(a.processKey, b.processKey)
  ));

  const perWorker = new Map();
  const picked = [];
  for (const row of ordered) {
    if (picked.length >= Math.max(0, Number(maxTrials) || 0)) break;
    const n = perWorker.get(row.worker) || 0;
    if (n >= Math.max(1, Number(maxPerWorker) || 1)) continue;
    perWorker.set(row.worker, n + 1);
    picked.push(row);
  }
  return picked;
}

/**
 * 実際に「この人がこの工程を持てる」仮定で引き直した結果だけを要約する。
 *
 * 🚨🚨 2026-09-07: ここは「良くなった所」しか見ていなかった。実測(repro):
 *     ① A が遅れ → B が遅れ（遅れが別のロットへ **移っただけ**）でも improves:true
 *     ② A が judgeable:false（**判定できなくなった**）でも「遅れを防いだ」と数えて improves:true
 *   どちらも「この人に教えると効きます」と画面に出る＝嘘。
 *   → 引き替えに失う物（新しく遅れる／判定できなくなる／ロットが消える）も同じ結果から数え、
 *     失う物が1件でも在れば improves は立てない。消さずに **両方** を返す。
 *
 * 返す verdict の4語:
 *   improves   … 得だけ（この手は効く）
 *   tradeoff   … 得も損もある（遅れを別のロットへ移すだけの手。効いた手には数えない）
 *   worse      … 損だけ
 *   no-change  … どちらも動かない
 */
export function compareSkillTrial({ base, trial, candidate } = {}) {
  const worker = text(candidate && candidate.worker);
  const beforeLate = lateLotIdsOf(base);
  const afterLate = lateLotIdsOf(trial);
  const beforeJudgeable = judgeableLotIdsOf(base);
  const afterJudgeable = judgeableLotIdsOf(trial);
  const afterLotIds = lotIdsOf(trial);
  const beforeUnresolved = unresolvedJobIdsOf(base);
  const afterUnresolved = unresolvedJobIdsOf(trial);
  const beforeAssigned = assignedJobIdsOf(base, worker);
  const afterAssigned = assignedJobIdsOf(trial, worker);
  /* 🚨 「遅れを防いだ」と言えるのは、引き直した後も **同じロットの納期を判定できている** 時だけ。
     判定できなくなったロットは遅れの一覧から消えるので、そのまま引き算すると「防いだ」に化ける。 */
  const avoidedLateLotIds = [...beforeLate].filter((id) => !afterLate.has(id) && afterJudgeable.has(id)).sort(cmp);
  /* 引き替えに **新しく遅れる** ロット。前に判定できていた物だけを数える（判定できなかった物が
     判定できるようになって「遅れ」と出たのは、この手が増やした遅れではない）。 */
  const newlyLateLotIds = [...afterLate].filter((id) => !beforeLate.has(id) && beforeJudgeable.has(id)).sort(cmp);
  const becameUnjudgeableLotIds = [...beforeJudgeable].filter((id) => !afterJudgeable.has(id)).sort(cmp);
  /* 行ごと消えたロット。数え漏れではなく「答えが出せなくなった」なので損に数える。
     ⚠ これは becameUnjudgeableLotIds の **内訳**（missingLotIds ⊆ becameUnjudgeableLotIds）。
       引き直した一覧に行が無ければ「判定できたロット」の集合にも入らないので、必ず両方に立つ。
       2026-09-08 実測: base=[A(遅れ・判定できる), B] の trial から A の行を丸ごと消すと
       becameUnjudgeableLotIds:['A'] と missingLotIds:['A'] の両方が返る。
       🚨 画面はこの2つを別々の丸札にしない（同じ1ロットが2ロットに読める）。 */
  const missingLotIds = [...beforeJudgeable].filter((id) => !afterLotIds.has(id)).sort(cmp);
  const resolvedJobIds = [...beforeUnresolved].filter((id) => !afterUnresolved.has(id)).sort(cmp);
  const newlyAssignedJobIds = [...afterAssigned].filter((id) => !beforeAssigned.has(id)).sort(cmp);
  const beforeIdleMs = skillIdleMsOf(base, worker);
  const afterIdleMs = skillIdleMsOf(trial, worker);
  const gain = avoidedLateLotIds.length > 0
    || resolvedJobIds.length > 0
    || newlyAssignedJobIds.length > 0
    || afterIdleMs < beforeIdleMs;
  const loss = newlyLateLotIds.length > 0
    || becameUnjudgeableLotIds.length > 0
    || missingLotIds.length > 0;
  return {
    ...candidate,
    avoidedLateLotIds,
    newlyLateLotIds,
    becameUnjudgeableLotIds,
    missingLotIds,
    resolvedJobIds,
    newlyAssignedJobIds,
    skillIdleMinutesBefore: Math.round(beforeIdleMs / MINUTE_MS),
    skillIdleMinutesAfter: Math.round(afterIdleMs / MINUTE_MS),
    skillIdleMinutesReduced: Math.max(0, Math.round((beforeIdleMs - afterIdleMs) / MINUTE_MS)),
    improves: gain && !loss,
    verdict: gain && !loss ? 'improves' : (gain && loss ? 'tradeoff' : (loss ? 'worse' : 'no-change')),
  };
}

