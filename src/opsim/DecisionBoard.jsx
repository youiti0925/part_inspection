/**
 * 🗂 割付と空き(DecisionBoard) — 人ごとの順番・空き・理由と、「どの担当記録があれば空きを仕事へ変えられるか」。
 *
 * 出どころ = Codex 13bb9d2(origin/codex/opsim-decision-board-20260903)。
 *   清水さん「全部確認してちゃんと入れて」(2026-09-23) で **画面の部分をそのまま** 接いだ。
 *   計算の側(src/domain/operationsSimulation/decisionBoard.js・Worker の技能試行)は master の物が既に在り、
 *   そちらの方が正しい(得と損を両方返す)ので **触っていない**。この画面が読む物だけ master の形へ合わせた:
 *     ・枝は skillTrials を配列で読んでいた → master は result.decisionBoard.trials(= result.skillTrials.rows と同じ配列)。
 *     ・枝は improves の真偽だけ見ていた → master は verdict の4語(improves / tradeoff / worse / no-change)。
 *       🚨 tradeoff(引き替えあり)・worse(損) を「効く」とは **見せない**。verdict の言葉をそのまま札に出す。
 *   🚨 2026-09-23 本番では runSkillTrials を Worker へ渡す口が1つも無く、技能試行が一度も出ていなかった。
 *     → この画面に「🎓 技能の試行を計算する」の押し口を置き、親(OperationsSimulationPanel)が次の計算で runSkillTrials:true を送る。
 *   数はここで1つも作らない(全部 Worker の答えをそのまま並べる)。px の直書きなし(rem か Tailwind の段だけ)。
 */
import React, { useMemo } from 'react';
import {
  AlertTriangle, ArrowRight, CheckCircle2, Clock3, GraduationCap, PauseCircle, UserRoundCheck,
} from 'lucide-react';

import { tplNameOf } from '../domain/workerPlan.js';

const MINUTE_MS = 60000;
const asArray = (value) => (Array.isArray(value) ? value.filter(Boolean) : []);
const clean = (value) => (value == null ? '' : String(value).trim());
const finite = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const lotIdOf = (lot) => clean(lot && (lot.lotId || lot.id || lot.__id));

/** master の compareSkillTrial が返す verdict の4語 → 画面の言葉。🚨 improves 以外を「効く」と読ませない。 */
const VERDICT_LABEL = Object.freeze({
  improves: '効く',
  tradeoff: '引き替えあり',
  worse: '損',
  'no-change': '変わらない',
});
const verdictOf = (row) => {
  const v = clean(row && row.verdict);
  if (VERDICT_LABEL[v]) return v;
  return row && row.improves === true ? 'improves' : 'no-change';
};
const verdictLabel = (row) => VERDICT_LABEL[verdictOf(row)];
const verdictTone = (row) => {
  const v = verdictOf(row);
  if (v === 'improves') return 'border-emerald-300 bg-emerald-50 text-emerald-900';
  if (v === 'tradeoff') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (v === 'worse') return 'border-rose-300 bg-rose-50 text-rose-900';
  return 'border-slate-300 bg-slate-50 text-slate-700';
};

/**
 * master の Worker の答えから技能試行の行を取り出す。
 *   result.decisionBoard.trials … 画面用の別名(同じ配列)
 *   result.decisionBoard.rows   … 監査の言い方(念のため)
 *   result.skillTrials.rows     … 元の置き場所
 * 🚨 1人1件(Worker が maxPerWorker:1 で作る)。ここでも同じ人の2件目は出さない(数を作らず、先頭だけ残す)。
 */
const trialsOf = (decisionBoard, result) => {
  const raw = asArray(
    (decisionBoard && (decisionBoard.trials || decisionBoard.rows))
    || (result && result.skillTrials && result.skillTrials.rows),
  );
  const seen = new Set();
  return raw.filter((row) => {
    const w = clean(row.worker);
    if (!w || seen.has(w)) return false;
    seen.add(w);
    return true;
  });
};

const fmtTime = (ms) => {
  const n = finite(ms);
  if (n == null) return '—';
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const fmtSpan = (ms) => {
  const n = finite(ms);
  if (n == null) return '—';
  const minutes = Math.max(0, Math.round(n / MINUTE_MS));
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}時間${rest}分` : `${hours}時間`;
};

const workLabelOf = (lot, templatesById) => {
  if (!lot) return '作業内容の記録なし';
  if (clean(lot.templateId) === 'final_inspection_std') {
    return clean(lot.specialConditions) || '特注仕様の記録なし';
  }
  return tplNameOf(templatesById, lot.templateId) || 'テンプレ名なし';
};

const reasonTone = (reason) => {
  if (clean(reason) === '技能の当てが無い') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (clean(reason) === '仕事なし') return 'border-slate-200 bg-slate-50 text-slate-600';
  if (/休み|勤務時間外|他の作業/.test(clean(reason))) return 'border-slate-200 bg-slate-100 text-slate-500';
  return 'border-cyan-200 bg-cyan-50 text-cyan-900';
};

const jobTone = (verdict) => {
  if (verdict && (verdict.late || verdict.blocked)) return 'border-rose-300 bg-rose-50';
  if (verdict && verdict.judgeable === false) return 'border-slate-300 bg-slate-50';
  return 'border-emerald-200 bg-emerald-50';
};

function SummaryLine({ working, free, skillFree, away, late, unassigned }) {
  const headline = skillFree > 0
    ? `いま ${free}人が空いています。うち ${skillFree}人は、仕事があっても担当の記録が合いません。`
    : free > 0
      ? `いま ${free}人が空いています。理由を人ごとに下へ出しています。`
      : `いまは ${working}人が作業中です。空いている人はいません。`;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-slate-300 bg-white px-3 py-2 shadow-sm">
      <div className="min-w-0 flex-1 text-sm font-black text-slate-900">{headline}</div>
      <div className="flex flex-wrap items-center gap-2 text-xs font-bold tabular-nums">
        <span className="text-cyan-700">作業中 {working}人</span>
        <span className={free ? 'text-amber-700' : 'text-slate-500'}>空き {free}人</span>
        <span className="text-slate-500">休み・時間外 {away}人</span>
        <span className={late ? 'text-rose-700' : 'text-emerald-700'}>遅れ見込み {late}件</span>
        <span className={unassigned ? 'text-rose-700' : 'text-slate-500'}>手が付かない {unassigned}件</span>
      </div>
    </div>
  );
}

function WorkItem({ row, lot, verdict, current = false, onSelectLot }) {
  const step = row.job || null;
  const workerRole = row.partnerOnly ? '2人作業の相方' : '';
  return (
    <button
      type="button"
      data-lot-id={row.lotId || undefined}
      onClick={() => row.lotId && onSelectLot && onSelectLot(row.lotId)}
      className={`min-h-11 w-[18rem] shrink-0 rounded-lg border px-2.5 py-2 text-left shadow-sm ${current ? 'ring-2 ring-cyan-400 ' : ''}${jobTone(verdict)}`}
    >
      <span className="flex items-center justify-between gap-2 text-xs font-black text-slate-900">
        <span className="truncate">{clean(lot && lot.model) || clean(step && step.model) || '品目コードなし'}</span>
        {current ? <span className="shrink-0 text-cyan-700">作業中</span> : null}
      </span>
      <span className="mt-0.5 block truncate text-xs font-bold text-slate-600">{workLabelOf(lot, row.templatesById)}</span>
      <span className="mt-0.5 block truncate text-xs text-slate-600">
        {clean(lot && lot.orderNo) ? `指図 ${clean(lot.orderNo)}・` : ''}{clean(step && step.title) || '工程名なし'}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-slate-500 tabular-nums">
        <span>{fmtTime(row.startMs)} → {fmtTime(row.endMs)}</span>
        <span>休み・休憩を除く実作業 {fmtSpan(row.workMs)}</span>
        {workerRole ? <span className="text-cyan-700">{workerRole}</span> : null}
      </span>
      {current && finite(row.remainingMs) != null ? (
        <span className="mt-1 block text-xs font-black text-cyan-800">残り {fmtSpan(row.remainingMs)}</span>
      ) : null}
      {verdict && verdict.late ? <span className="mt-1 block text-xs font-black text-rose-700">納期を越える見込み</span> : null}
      {verdict && verdict.blocked ? <span className="mt-1 block text-xs font-black text-rose-700">{verdict.blocked}</span> : null}
    </button>
  );
}

function IdleItem({ row, trial }) {
  return (
    <div className={`min-w-[9rem] rounded-lg border px-2.5 py-2 ${reasonTone(row.reason)}`}>
      <div className="flex items-center gap-1.5 text-xs font-black">
        <PauseCircle className="h-4 w-4 shrink-0" />
        空き {finite(row.toMs) != null && finite(row.fromMs) != null && row.toMs > row.fromMs ? fmtSpan(row.toMs - row.fromMs) : ''}
      </div>
      <div className="mt-0.5 text-xs font-bold">{row.reason || '理由の記録なし'}</div>
      {finite(row.toMs) != null && finite(row.fromMs) != null && row.toMs > row.fromMs ? (
        <div className="mt-0.5 text-2xs tabular-nums">{fmtTime(row.fromMs)} → {fmtTime(row.toMs)}</div>
      ) : null}
      {trial ? (
        <div className="mt-1 border-t border-current/20 pt-1 text-xs font-bold">
          {trial.processTitle || '工程名なし'}の担当記録があれば
          {asArray(trial.newlyAssignedJobIds).length ? ` ${asArray(trial.newlyAssignedJobIds).length}工程を担当` : ''}
          {trial.skillIdleMinutesReduced > 0 ? `・空き${fmtSpan(trial.skillIdleMinutesReduced * MINUTE_MS)}減` : ''}
          {asArray(trial.avoidedLateLotIds).length ? `・遅れ${asArray(trial.avoidedLateLotIds).length}件減` : ''}
        </div>
      ) : null}
    </div>
  );
}

function WorkerLane({ lane, trials, lotsById, verdictByLot, templatesById, onSelectLot }) {
  /* 🚨 人の行に添えるのは verdict が improves(効く) の物だけ。引き替えあり・損は右の一覧で言葉付きで出す。 */
  const trial = trials.find((row) => clean(row.worker) === lane.name && verdictOf(row) === 'improves') || null;
  return (
    <section className="grid grid-cols-1 gap-2 border-b border-slate-200 py-2.5 last:border-b-0 lg:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="flex items-center gap-2 lg:block">
        <div className="text-sm font-black text-slate-900">{lane.name}</div>
        <div className={`mt-0.5 text-xs font-bold ${lane.current ? 'text-cyan-700' : lane.away ? 'text-slate-500' : 'text-amber-700'}`}>
          {lane.current ? '作業中' : lane.away ? lane.reason : '空いています'}
        </div>
      </div>
      <div className="flex min-w-0 items-stretch gap-2 overflow-x-auto pb-1">
        {lane.items.length ? lane.items.map((item, index) => (
          item.kind === 'idle' ? (
            <IdleItem key={`idle-${item.fromMs}-${item.toMs}`} row={item} trial={trial} />
          ) : (
            <React.Fragment key={`${item.jobId}-${item.startMs}`}>
              {index > 0 ? <ArrowRight className="mt-6 h-4 w-4 shrink-0 text-slate-300" /> : null}
              <WorkItem
                row={{ ...item, templatesById }}
                lot={lotsById.get(item.lotId)}
                verdict={verdictByLot.get(item.lotId)}
                current={item.current}
                onSelectLot={onSelectLot}
              />
            </React.Fragment>
          )
        )) : (
          <IdleItem row={{ fromMs: lane.nowMs, toMs: lane.nextBoundaryMs, reason: lane.reason }} trial={trial} />
        )}
      </div>
    </section>
  );
}

/**
 * どの担当記録があれば、空きを仕事へ変えられるか。
 *   ran=false … まだ押していない(Worker は既定で技能試行を回さない。1件 約3秒)。押し口を出す。
 *   ran=true  … Worker の答え。verdict の4語を **そのまま** 札に。候補0件の時は whyNoCandidate の文をそのまま。
 */
function SkillOptions({ trials, ran, whyNoCandidate, trialTotalMs, error, lotsById, templatesById, onSelectLot, onRunTrials, loading }) {
  return (
    <aside className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <div className="flex items-center gap-2 text-sm font-black text-amber-950">
        <GraduationCap className="h-5 w-5" />
        どの担当記録があれば、空きを仕事へ変えられるか
      </div>
      <div className="mt-1 text-xs leading-snug text-amber-900">
        名前を当てただけではありません。その人をその工程の担当候補に加えて、もう一度割付した差です。
      </div>
      {/* 🚨 2026-09-23 本番では runSkillTrials を渡す口が無く 技能試行が一度も出ていなかった → ここが唯一の押し口。 */}
      <button
        type="button"
        data-opsim-run-skill-trials="1"
        disabled={!!loading || typeof onRunTrials !== 'function'}
        onClick={() => { if (typeof onRunTrials === 'function') onRunTrials(); }}
        className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-amber-400 bg-white px-3 py-2 text-sm font-black text-amber-900 shadow-sm hover:bg-amber-100 disabled:opacity-60"
      >
        🎓 技能の試行を計算する
        <span className="text-2xs font-bold text-amber-700">{loading ? '（計算中）' : ran ? '（もう一度）' : '（1人1件・1件あたり約3秒）'}</span>
      </button>
      {!ran ? (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600">
          まだ計算していません。押すと、空いている人ごとに「この工程の担当記録があれば」を実際に割付し直して出します。
        </div>
      ) : error ? (
        <div className="mt-2 rounded-lg border border-rose-200 bg-white px-2.5 py-2 text-xs text-rose-700">計算が途中で止まりました: {error}</div>
      ) : trials.length ? (
        <div className="mt-2 space-y-2">
          {trials.map((row) => {
            const lot = lotsById.get(clean(row.lotId)) || null;
            const skillIds = asArray(row.requiredSkillIds);
            const v = verdictOf(row);
            return (
              <button
                type="button"
                key={`${row.worker}-${row.processKey}`}
                data-opsim-trial-verdict={v}
                onClick={() => row.lotId && onSelectLot && onSelectLot(clean(row.lotId))}
                className={`min-h-11 w-full rounded-lg border px-2.5 py-2 text-left shadow-sm hover:opacity-90 ${verdictTone(row)}`}
              >
                <span className="flex items-center justify-between gap-2 text-xs font-black text-slate-900">
                  <span className="truncate">{row.worker}さん × {row.processTitle || '工程名なし'}</span>
                  <span className="shrink-0 rounded-md border border-current px-1.5 py-0.5 text-2xs">{verdictLabel(row)}</span>
                </span>
                <span className="mt-0.5 block text-xs text-slate-600">
                  {clean(lot && lot.model) || clean(row.model) || '品目コードなし'}｜{workLabelOf(lot, templatesById)}
                  {clean(lot && lot.orderNo) ? `｜指図 ${clean(lot.orderNo)}` : ''}
                </span>
                {skillIds.length ? <span className="mt-0.5 block text-2xs text-slate-500">テンプレ設定の必要スキル: {skillIds.join('・')}</span> : null}
                <span className="mt-1 block text-xs font-black">
                  {asArray(row.newlyAssignedJobIds).length ? `${asArray(row.newlyAssignedJobIds).length}工程を新たに担当` : '新たに担当する工程なし'}
                  {row.skillIdleMinutesReduced > 0 ? ` ／ 空き ${fmtSpan(row.skillIdleMinutesReduced * MINUTE_MS)}減` : ''}
                  {asArray(row.avoidedLateLotIds).length ? ` ／ 遅れ ${asArray(row.avoidedLateLotIds).length}件減` : ''}
                  {asArray(row.resolvedJobIds).length ? ` ／ 手が付かない工程 ${asArray(row.resolvedJobIds).length}件減` : ''}
                </span>
                {/* 🚨 損の側(master が返す)を消さない。引き替えあり・損 の理由はここ。 */}
                {asArray(row.newlyLateLotIds).length || asArray(row.becameUnjudgeableLotIds).length ? (
                  <span className="mt-0.5 block text-xs font-bold text-rose-700">
                    {asArray(row.newlyLateLotIds).length ? `引き替えに新しく遅れる ${asArray(row.newlyLateLotIds).length}件` : ''}
                    {asArray(row.newlyLateLotIds).length && asArray(row.becameUnjudgeableLotIds).length ? ' ／ ' : ''}
                    {asArray(row.becameUnjudgeableLotIds).length ? `納期の判定が出せなくなる ${asArray(row.becameUnjudgeableLotIds).length}件` : ''}
                  </span>
                ) : null}
              </button>
            );
          })}
          {finite(trialTotalMs) != null ? (
            <div className="text-2xs text-slate-500 tabular-nums">割付のやり直し {trials.length}回・合計 {Math.round(trialTotalMs / 1000)}秒（実測）</div>
          ) : null}
        </div>
      ) : (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-600">
          {clean(whyNoCandidate && whyNoCandidate.sentence)
            || '仮に付ける候補が0件でした（「技能の当てが無い」で手が空いた時間が記録されていません）。'}
        </div>
      )}
    </aside>
  );
}

function LateLedger({ lotResults, lateDone, lotsById, templatesById, onSelectLot }) {
  const future = lotResults.filter((row) => row && row.late === true);
  const done = asArray(lateDone && lateDone.rows);
  if (!future.length && !done.length) return null;
  return (
    <section className="rounded-xl border border-rose-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-black text-rose-900">
        <AlertTriangle className="h-5 w-5" />
        遅れは、完了してもここから消えません
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">
        <div>
          <div className="mb-1 text-xs font-black text-rose-700">これから・いま遅れる見込み {future.length}件</div>
          <div className="space-y-1">
            {future.slice(0, 8).map((row) => {
              const lot = lotsById.get(clean(row.lotId));
              const lateMs = finite(row.lateMs);
              return (
                <button type="button" key={row.lotId} onClick={() => onSelectLot && onSelectLot(clean(row.lotId))} className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-rose-50 px-2 py-1.5 text-left text-xs">
                  <span className="min-w-0 flex-1 truncate font-bold text-slate-800">{clean(lot && lot.model) || '品目コードなし'}｜{workLabelOf(lot, templatesById)}｜指図 {clean(lot && lot.orderNo) || 'なし'}</span>
                  <span className="shrink-0 font-black text-rose-700">{lateMs == null ? '期間内に終わりません' : `${fmtSpan(lateMs)}超過`}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div className="mb-1 text-xs font-black text-slate-600">遅れて完了した記録 {done.length}件</div>
          <div className="space-y-1">
            {done.slice(0, 8).map((row) => {
              const lot = lotsById.get(clean(row.lotId));
              return (
                <button type="button" key={row.lotId} onClick={() => onSelectLot && onSelectLot(clean(row.lotId))} className="flex min-h-11 w-full items-center gap-2 rounded-lg bg-slate-100 px-2 py-1.5 text-left text-xs">
                  <span className="min-w-0 flex-1 truncate font-bold text-slate-800">{clean(row.model) || clean(lot && lot.model) || '品目コードなし'}｜{workLabelOf(lot, templatesById)}｜指図 {clean(row.orderNo) || 'なし'}</span>
                  <span className="shrink-0 font-black text-slate-700">納期より {row.daysLate}日遅れて完了</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * @param {object} p
 * @param {object|null} p.decisionBoard  result.decisionBoard(master の Worker: {trials, whyNoCandidate, trialMs}。押していない時は null)
 * @param {object|null} p.result         Worker の答えそのもの。snapshot/assignments 等を個別に渡さない時はここから読む
 * @param {object|null} p.snapshot       いま見ている時刻の記録(親が targetMs で選んだ物)。無ければ result.base.snapshots の先頭
 * @param {function}    p.onRunTrials    「🎓 技能の試行を計算する」を押した時(親が次の計算に runSkillTrials:true を載せる)
 * @param {boolean}     p.loading        計算中
 * @param {function}    p.onPickLot      ロットの札を押した時(onSelectLot と同じ。どちらか)
 */
export function DecisionBoard({
  decisionBoard = null,
  result = null,
  snapshot = null,
  assignments = null,
  idleLog = null,
  unresolved = null,
  jobs = null,
  lots = null,
  lotResults = null,
  templatesById = null,
  lateDone = null,
  nowMs = null,
  toMs = null,
  onSelectLot = null,
  onPickLot = null,
  onRunTrials = null,
  loading = false,
}) {
  const base = (result && result.base) || null;
  const snap = snapshot || (base && asArray(base.snapshots)[0]) || null;
  const effAssignments = assignments || (base && base.assignments) || null;
  const effIdleLog = idleLog || (base && base.idleLog) || null;
  const effUnresolved = unresolved || (base && base.unresolved) || null;
  const effJobs = jobs || (result && result.normalized && result.normalized.jobs) || null;
  const effLotResults = lotResults || (base && base.lotResults) || null;
  const effToMs = finite(toMs) ?? finite(result && result.normalized && result.normalized.horizonEnd);
  const pick = onSelectLot || onPickLot || null;
  const ran = !!(decisionBoard || (result && result.skillTrials));
  // 🚨 2026-09-23 写しで発覚: ok!==false の時 clean(false) が 'false' になり、成功しても「計算が途中で止まりました: false」と出ていた。失敗の時だけ文にする
  const trialError = result && result.skillTrials && result.skillTrials.ok === false ? (clean(result.skillTrials.error) || '理由が取れませんでした') : '';
  const whyNoCandidate = (decisionBoard && decisionBoard.whyNoCandidate) || (result && result.skillTrials && result.skillTrials.whyNoCandidate) || null;
  const trialTotalMs = finite(result && result.skillTrials && result.skillTrials.totalMs)
    ?? (asArray(decisionBoard && decisionBoard.trialMs).length ? asArray(decisionBoard.trialMs).reduce((a, b) => a + (finite(b) || 0), 0) : null);

  const data = useMemo(() => {
    const at = finite(nowMs) ?? finite(snap && snap.atMs) ?? 0;
    const end = effToMs ?? at;
    const rawLots = asArray(lots);
    const lotsById = new Map(rawLots.map((lot) => [lotIdOf(lot), lot]));
    const jobById = new Map(asArray(effJobs).map((job) => [clean(job.jobId), job]));
    const verdictByLot = new Map(asArray(effLotResults).map((row) => [clean(row.lotId), row]));
    const trials = trialsOf(decisionBoard, result);
    const baseAssignments = asArray(effAssignments);
    const baseIdle = asArray(effIdleLog);
    const workers = asArray(snap && snap.workers);

    const lanes = workers.map((worker) => {
      const name = clean(worker.name);
      const working = clean(worker.state) === 'working';
      const away = !working && /休み|勤務時間外|他の作業/.test(clean(worker.reason));
      const rows = baseAssignments
        .filter((row) => (clean(row.worker) === name || clean(row.partner) === name) && (finite(row.endMs) ?? 0) > at)
        .sort((a, b) => (finite(a.startMs) ?? 0) - (finite(b.startMs) ?? 0));
      const items = [];
      let cursor = at;
      rows.slice(0, 5).forEach((row) => {
        const start = finite(row.startMs) ?? cursor;
        const endMs = finite(row.endMs) ?? start;
        if (start > cursor) {
          const idle = baseIdle.find((idleRow) => clean(idleRow.worker) === name
            && (finite(idleRow.fromMs) ?? Infinity) <= cursor
            && (finite(idleRow.toMs) ?? -Infinity) >= start);
          items.push({ kind: 'idle', fromMs: cursor, toMs: start, reason: clean(idle && idle.reason) || clean(worker.reason) || '理由の記録なし' });
        }
        const job = jobById.get(clean(row.jobId)) || null;
        const lotId = clean(row.lotId) || clean(job && job.lotId);
        const current = working && clean(worker.jobId) === clean(row.jobId) && start <= at && at < endMs;
        items.push({
          kind: 'work', jobId: clean(row.jobId), lotId, job,
          startMs: start, endMs, workMs: finite(job && job.durationMs) ?? Math.max(0, endMs - start),
          current, remainingMs: current ? finite(worker.remainingMs) : null,
          partnerOnly: clean(row.partner) === name && clean(row.worker) !== name,
        });
        cursor = Math.max(cursor, endMs);
      });
      if (!items.length && !working) {
        const currentIdle = baseIdle.find((idleRow) => clean(idleRow.worker) === name
          && (finite(idleRow.fromMs) ?? Infinity) <= at
          && at < (finite(idleRow.toMs) ?? -Infinity));
        items.push({
          kind: 'idle',
          fromMs: at,
          toMs: finite(currentIdle && currentIdle.toMs),
          reason: clean(currentIdle && currentIdle.reason) || clean(worker.reason) || '理由の記録なし',
        });
      }
      return {
        name, current: working, away, reason: clean(worker.reason) || (working ? '' : '理由の記録なし'),
        items, nowMs: at, nextBoundaryMs: Math.max(at, end),
      };
    }).sort((a, b) => Number(b.current) - Number(a.current) || Number(a.away) - Number(b.away) || a.name.localeCompare(b.name));

    const working = lanes.filter((lane) => lane.current).length;
    const away = lanes.filter((lane) => lane.away).length;
    const free = lanes.length - working - away;
    const skillFree = lanes.filter((lane) => !lane.current && !lane.away && lane.reason === '技能の当てが無い').length;
    const late = asArray(effLotResults).filter((row) => row && row.late === true).length;
    const unresolvedLots = new Set(asArray(effUnresolved).map((row) => clean(jobById.get(clean(row.jobId))?.lotId)).filter(Boolean));
    return { at, lotsById, verdictByLot, trials, lanes, working, away, free, skillFree, late, unresolvedLots };
  }, [snap, effAssignments, effIdleLog, effUnresolved, effJobs, lots, effLotResults, decisionBoard, result, nowMs, effToMs]);

  if (!snap) {
    return <div className="rounded-xl border border-slate-200 bg-white px-3 py-4 text-sm text-slate-600">割付を計算すると、ここに人ごとの順番・空き・理由が出ます。</div>;
  }

  return (
    <div className="flex flex-col gap-2.5" data-opsim-decision-board="1">
      <SummaryLine
        working={data.working}
        free={data.free}
        skillFree={data.skillFree}
        away={data.away}
        late={data.late}
        unassigned={data.unresolvedLots.size}
      />
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="rounded-xl border border-slate-200 bg-white px-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 py-2">
            <UserRoundCheck className="h-5 w-5 text-cyan-700" />
            <div className="text-sm font-black text-slate-900">誰が、どの順で、いつ終わるか</div>
            <div className="ml-auto flex items-center gap-1 text-xs text-slate-500 tabular-nums"><Clock3 className="h-4 w-4" />{fmtTime(data.at)} 時点</div>
          </div>
          {data.lanes.map((lane) => (
            <WorkerLane
              key={lane.name}
              lane={lane}
              trials={data.trials}
              lotsById={data.lotsById}
              verdictByLot={data.verdictByLot}
              templatesById={templatesById}
              onSelectLot={pick}
            />
          ))}
        </section>
        <SkillOptions
          trials={data.trials}
          ran={ran}
          whyNoCandidate={whyNoCandidate}
          trialTotalMs={trialTotalMs}
          error={trialError}
          lotsById={data.lotsById}
          templatesById={templatesById}
          onSelectLot={pick}
          onRunTrials={onRunTrials}
          loading={loading}
        />
      </div>
      <LateLedger lotResults={asArray(effLotResults)} lateDone={lateDone} lotsById={data.lotsById} templatesById={templatesById} onSelectLot={pick} />
      <div className="flex items-start gap-1.5 text-xs text-slate-500">
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
        仕事は順番で並べ、休み・休憩を除いた実作業時間を札の中に表示します。休日を時間の棒へ混ぜて長く見せません。
      </div>
    </div>
  );
}

export default DecisionBoard;
