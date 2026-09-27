import React, { useMemo, useState } from 'react';
import { readParallelLabConfig, buildPhaseProfile, buildCandidateJob, travelMinutesOf, travelKey } from '../../domain/parallelLab/phaseProfile.js';
import { compareThree, PLAN_KEYS } from '../../domain/parallelLab/compareThree.js';
import { buildParallelLabScenario, compareWholePlans } from '../../domain/parallelLab/wholePlan.js';
import { readAdoption, adoptionBlockers, adoptionFingerprint, buildAdoptionRecord, applyAdoption, revertAdoption, fieldInstructionsOf } from '../../domain/parallelLab/adoption.js';
import { isAutoStep } from '../../domain/workExecution.js';

/* 🧪 2026-09-22 夜 並列作業の比較シミュレーション(ラボ)。設計: docs/並列作業_比較シミュレーション_設計.md
   🚨 本番の割付・計画の版・現場の指示には **採用した条件(settings.opsim.parallelLabAdoption.current)以外** 何も書かない。
   🚨 数字は純関数(compareThree / compareWholePlans / adoption)の物をそのまま。根拠が無い時は「材料が無い」を名指しで出す。
   📐 2026-09-23 第三者の3点: 往復が未登録の結果は暫定(採用は登録の後)／設備の解放時点は設定で明示／遅くなるロットは分数と納期の余裕まで。
   流れ: 不足条件を確認 → 全体で比較 → 悪化するロットを確認 → 採用する条件を保存 → 現場へ提示(図)。 */
const control = 'min-h-11 rounded-lg border border-slate-400 bg-white px-3 py-2 text-base text-slate-900';
const KIND_COLOR = { idle: 'bg-slate-300', auto: 'bg-sky-300', finish: 'bg-emerald-400', travel: 'bg-amber-300', work: 'bg-violet-400', wait: 'bg-red-400' };
const KIND_LABEL = { idle: '手待ち', auto: '自動運転', finish: '終了対応', travel: '移動', work: '手作業', wait: '終了後の人待ち' };
const hm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const md = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${hm(ms)}`; };
const str = (v) => (v == null ? '' : String(v));
const toLocalInput = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

function Lane({ label, segments, fromMs, toMs }) {
  const span = Math.max(1, toMs - fromMs);
  return (
    <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
      <div className="text-sm font-bold text-slate-700">{label}</div>
      <div className="relative h-6 rounded bg-slate-100">
        {segments.map((s, i) => (
          <div key={i} className={`absolute top-0 h-6 rounded ${KIND_COLOR[s.kind] || 'bg-slate-400'}`} title={`${KIND_LABEL[s.kind] || s.kind} ${hm(s.fromMs)}〜${hm(s.toMs)}`}
            style={{ left: `${((s.fromMs - fromMs) / span) * 100}%`, width: `${Math.max(0.5, ((s.toMs - s.fromMs) / span) * 100)}%` }} />
        ))}
      </div>
    </div>
  );
}

/* 🎞 Codex 版(codex/parallel-work-lab-handoff-20260922 の ui.js)で清水さんが良いと言った見せ方を本番ラボへ:
   共通の時計(再生時点)・機械の進捗円(A/B)・動く作業者・3案を同じ時刻で並べる。数字は segments(純関数)から。 */
function Scene({ plan, tMs, nowMs, autoEndMs, autoTotalMs }) {
  const segs = plan.segments;
  const at = (who) => segs.find((s) => s.who === who && s.fromMs <= tMs && tMs < s.toMs) || null;
  const w = at('worker');
  const left = 70, right = 270;
  let x = left; let word = '手待ち';
  if (w) {
    if (w.kind === 'travel') { const f = (tMs - w.fromMs) / Math.max(1, w.toMs - w.fromMs); x = w.label === 'Bへ移動' ? left + (right - left) * f : right - (right - left) * f; word = w.label; }
    else if (w.kind === 'work') { x = right; word = 'Bの手作業'; }
    else { x = left; word = w.label || '手待ち'; }
  } else if (tMs >= plan.aDoneMs) { x = left; word = '完了'; }
  const aSeg = at('A'); const bSeg = at('B');
  const aStart = autoEndMs - autoTotalMs;
  const aProg = Math.max(0, Math.min(1, (tMs - aStart) / Math.max(1, (plan.aDoneMs - aStart))));
  const aWaiting = aSeg && aSeg.kind === 'wait';
  const aStatus = tMs >= plan.aDoneMs ? '完了 ✓' : aWaiting ? '終了後の人待ち' : aSeg && aSeg.kind === 'finish' ? '終了対応中' : tMs < autoEndMs ? `自動 残り${Math.max(0, Math.ceil((autoEndMs - tMs) / 60000))}分` : '—';
  const bDoneMs = plan.bDoneMs; const bSegs = segs.filter((s) => s.who === 'B');
  const bTotal = bSegs.reduce((n, s) => n + (s.toMs - s.fromMs), 0);
  const bDone = bSegs.reduce((n, s) => n + Math.max(0, Math.min(tMs, s.toMs) - s.fromMs), 0);
  const bStatus = bTotal === 0 ? '進まない' : bDoneMs && tMs >= bDoneMs ? '完了 ✓' : bSeg ? `手作業 残り${Math.max(0, Math.ceil((bTotal - bDone) / 60000))}分` : bDone > 0 ? '中断' : '未着手';
  const circ = 2 * Math.PI * 30;
  const station = (cx, label, pc, status, alert, color) => (
    <g transform={`translate(${cx} 60)`}>
      <circle r="30" fill="#f8faff" stroke="#e4eaf2" strokeWidth="5" />
      <circle r="30" fill="none" stroke={alert ? '#bc2949' : color} strokeWidth="5" strokeDasharray={`${circ * pc} ${circ}`} transform="rotate(-90)" />
      <text y="6" textAnchor="middle" fontSize="16" fontWeight="700" fill={color}>{label}</text>
      <text y="52" textAnchor="middle" fontSize="12" fill="#334155">{status}</text>
    </g>
  );
  return (
    <svg viewBox="0 0 340 170" className="w-full max-w-md" role="img" aria-label={`${hm(tMs)} A ${aStatus}、B ${bStatus}、作業者は${word}`} data-parallel-lab-scene={plan.key}>
      {station(left, 'A', aProg, aStatus, aWaiting, '#2261a7')}
      {station(right, 'B', bTotal ? Math.min(1, bDone / bTotal) : 0, bStatus, false, '#0a8073')}
      <path d={`M${left} 150 H${right}`} stroke="#ddd6e9" strokeWidth="8" strokeLinecap="round" />
      <g transform={`translate(${x} 150)`}>
        <circle cy="-13" r="13" fill="white" opacity=".9" /><circle cy="-18" r="7" fill="#17283f" />
        <path d="M-9 -7 Q0 -13 9 -7 L8 6 L-8 6Z" fill="#17283f" /><path d="M-5 6 L-8 17 M5 6 L8 17" stroke="#17283f" strokeWidth="4" strokeLinecap="round" />
      </g>
      <text x="170" y="12" textAnchor="middle" fontSize="12" fill="#334155">{hm(tMs)}{tMs <= nowMs ? '（いま）' : ''}・作業者: {word}</text>
    </svg>
  );
}

/* 🏭 現場へ見せる図(採用した条件が本番の割付に効いている時だけ): 「今はBを進める／何時までにAへ戻る／予定が外れたら」を人ごとに。
   数字は fieldInstructionsOf(本番の結果の assignments)から。 */
function FieldCard({ fi, lotLabel, nowMs }) {
  // 帯は 自動の開始〜終了対応の終わり(いまが手前でも帯を潰さない。いまは中に在る時だけ線)
  const from = fi.autoStartMs, to = fi.finishEndMs;
  const span = Math.max(1, to - from);
  const px = (ms) => `${((ms - from) / span) * 100}%`;
  return (
    <div className="rounded-lg border-2 border-emerald-700 bg-white p-2" data-parallel-lab-field-card={fi.worker}>
      <div className="text-base font-bold">{fi.worker}: {fi.during.length ? `いま ${fi.during.map((d) => lotLabel(d.lotId)).join('・')} を進める` : '自動の間に進める仕事はありません'}</div>
      <div className="text-base font-bold text-emerald-800">⏰ {hm(fi.returnByMs)} までに {lotLabel(fi.aLotId)} へ戻る（自動の予定終了 {hm(fi.autoEndMs)}・終了対応 {hm(fi.finishStartMs)}〜{hm(fi.finishEndMs)}）</div>
      <div className="relative mt-1 h-8 rounded bg-slate-100">
        <div className="absolute top-0 h-3 rounded bg-sky-300" style={{ left: px(fi.autoStartMs), width: `${((fi.autoEndMs - fi.autoStartMs) / span) * 100}%` }} title={`A 自動 ${hm(fi.autoStartMs)}〜${hm(fi.autoEndMs)}`} />
        <div className="absolute top-0 h-3 rounded bg-emerald-400" style={{ left: px(fi.finishStartMs), width: `${Math.max(0.5, ((fi.finishEndMs - fi.finishStartMs) / span) * 100)}%` }} title="終了対応" />
        {fi.during.map((d) => <div key={d.jobId} className="absolute top-4 h-3 rounded bg-violet-400" style={{ left: px(d.startMs), width: `${Math.max(0.5, ((Math.min(d.endMs, to) - d.startMs) / span) * 100)}%` }} title={`${lotLabel(d.lotId)} ${hm(d.startMs)}〜${hm(d.endMs)}`} />)}
        <div className="absolute top-0 h-8 w-0.5 bg-red-600" style={{ left: px(fi.returnByMs) }} title={`戻る ${hm(fi.returnByMs)}`} />
        {nowMs >= from && nowMs <= to && <div className="absolute top-0 h-8 w-0.5 bg-slate-900" style={{ left: px(nowMs) }} title="いま" />}
      </div>
      <ul className="mt-1 list-disc pl-5 text-xs text-slate-700">{fi.ifLate.map((l) => <li key={l}>{l}</li>)}</ul>
    </div>
  );
}

export default function ParallelLabPanel({ lots = [], result = null, settings = null, nowMs, canEdit = false, saveOpsim = null, runRung = null, adopted = null }) {
  const [open, setOpen] = useState(false);
  const [aKey, setAKey] = useState('');      // `${lotId}|${stepId}|${unitIndex}`
  const [bKey, setBKey] = useState('');      // jobId
  const [assumedStartHM, setAssumedStartHM] = useState('');   // 記録に開始時刻が無い時、人が指定する(指定した事を札で出す)
  const [autoDeltaMin, setAutoDeltaMin] = useState(0);
  const [bDeltaMin, setBDeltaMin] = useState(0);
  const [aZone, setAZone] = useState('');   // ロットに場所の登録が無い時、試す為に指定する(札に出す)
  const [bZone, setBZone] = useState('');
  const [playMin, setPlayMin] = useState(0);   // 🕒 共通の時計(再生時点・基準からの分)。3案を同じ時刻で見る
  const [applyFrom, setApplyFrom] = useState('');   // 採用の適用開始(空=いま)
  const [adoptMsg, setAdoptMsg] = useState('');
  const zones = useMemo(() => [...new Set(lots.map((l) => str(l.mapZoneId)).filter(Boolean))].sort(), [lots]);
  const cfg = useMemo(() => readParallelLabConfig(settings), [settings]);
  const adoption = useMemo(() => readAdoption(settings), [settings]);
  const jobs = useMemo(() => (result && result.normalized && Array.isArray(result.normalized.jobs) ? result.normalized.jobs : []), [result]);
  // ロットA の候補: 自動運転の工程を持つロット(記録に開始時刻が在る物を先に)
  const aOptions = useMemo(() => {
    const out = [];
    for (const l of lots) {
      for (const s of (Array.isArray(l.steps) ? l.steps : [])) {
        if (!isAutoStep(s)) continue;
        const keys = Object.keys(l.tasks && !Array.isArray(l.tasks) ? l.tasks : {}).filter((k) => k === s.id || k.startsWith(`${s.id}-`));
        const units = keys.length ? keys.map((k) => (k === s.id ? null : Number(k.slice(s.id.length + 1)))) : [0];
        for (const u of units) {
          const t = l.tasks && l.tasks[u == null ? s.id : `${s.id}-${u}`];
          const started = t && (t.batchStartedAt || t.startTime) && t.status !== 'completed';
          out.push({ key: `${l.id}|${s.id}|${u == null ? '' : u}`, label: `${l.model || ''}｜${s.title}${u == null ? '' : ` ${u + 1}台目`}${started ? '（自動運転中）' : ''} 指図${l.orderNo || ''}`, started: !!started, lot: l, step: s, unit: u });
        }
      }
    }
    return out.sort((x, y) => Number(y.started) - Number(x.started));
  }, [lots]);
  // 📋 工程ごとの一覧(自動運転の工程を id ごとに1行。品目コードは見本を3つ)
  const stepRows = useMemo(() => {
    const m = new Map();
    for (const l of lots) for (const s of (Array.isArray(l.steps) ? l.steps : [])) {
      if (!isAutoStep(s)) continue;
      const r = m.get(str(s.id)) || { stepId: str(s.id), title: str(s.title), lots: 0, models: new Set(), autoSec: Number(s.autoEndSec) || 0 };
      r.lots += 1; if (l.model) r.models.add(str(l.model)); m.set(str(s.id), r);
    }
    return [...m.values()].sort((x, y) => y.lots - x.lots);
  }, [lots]);
  const zonePairs = useMemo(() => { const out = []; for (let i = 0; i < zones.length; i += 1) for (let j = i + 1; j < zones.length; j += 1) out.push(travelKey(zones[i], zones[j])); return out; }, [zones]);
  // 🚨 第三者(2026-09-23)④: 自動運転の工程は B(手作業)の候補に出さない(domain の buildCandidateJob も同じ判定で断る)
  const lotById = useMemo(() => new Map(lots.map((l) => [String(l.id), l])), [lots]);
  const a = aOptions.find((o) => o.key === aKey) || null;
  const bOptions = useMemo(() => jobs.filter((j) => { if (!j || j.durationKnown === false || !Number.isFinite(j.durationMs) || (a && String(j.lotId) === String(a.lot.id))) return false; const l = lotById.get(String(j.lotId)); const st = l && Array.isArray(l.steps) ? l.steps.find((s) => String(s.id) === String(j.stepId)) : null; return !(st && isAutoStep(st)); }).slice(0, 400), [jobs, a, lotById]);
  const labelOf = (id) => { const l = lotById.get(String(id)); return l ? `${l.model || ''} 指図${l.orderNo || ''}` : String(id); };
  const bJob = bOptions.find((j) => j.jobId === bKey) || null;
  const bLot = bJob ? lots.find((l) => String(l.id) === String(bJob.lotId)) : null;

  // 記録に開始時刻が無い時は、人が指定した時刻を使う(推測ではなく指定。札に出す)
  const lotForA = useMemo(() => {
    if (!a) return null;
    const tk = a.unit == null ? a.step.id : `${a.step.id}-${a.unit}`;
    const t = a.lot.tasks && a.lot.tasks[tk];
    if (t && (t.batchStartedAt || t.startTime) || !assumedStartHM) return a.lot;
    const [h, m] = assumedStartHM.split(':').map(Number);
    const d = new Date(nowMs); d.setHours(h || 0, m || 0, 0, 0);
    return { ...a.lot, tasks: { ...(a.lot.tasks || {}), [tk]: { ...(t || {}), batchStartedAt: d.getTime(), assumed: true } } };
  }, [a, assumedStartHM, nowMs]);
  const profile = useMemo(() => (lotForA ? buildPhaseProfile({ lot: lotForA, stepId: a.step.id, unitIndex: a.unit, nowMs, cfg }) : null), [lotForA, a, nowMs, cfg]);
  const candidate = useMemo(() => (bJob && bLot ? buildCandidateJob({ lot: bLot, stepId: bJob.stepId, unitIndex: bJob.unitIndex, workMs: bJob.durationMs, workSource: `見立ての所要（${str(bJob.estimateSource || result?.normalized?.estimateMode || '見積')}）`, cfg }) : null), [bJob, bLot, cfg, result]);
  const aZoneEff = a ? (str(a.lot.mapZoneId) || aZone) : '';
  const bZoneEff = bLot ? (str(bLot.mapZoneId) || bZone) : '';
  const travelMin = useMemo(() => (a && bLot ? travelMinutesOf(cfg, aZoneEff, bZoneEff) : null), [a, bLot, cfg, aZoneEff, bZoneEff]);
  const urgent = !!(a && (a.lot.priority === 'urgent' || a.lot.priority === 'high'));
  const cmp = useMemo(() => (profile && candidate ? compareThree({ profile, candidate, travelMin, returnMarginMin: cfg.returnMarginMin, nowMs, aDueMs: Number.isFinite(a?.lot?.dueMs) ? a.lot.dueMs : null, shift: { autoDeltaMin: Number(autoDeltaMin) || 0, bDeltaMin: Number(bDeltaMin) || 0 }, urgent, urgentPolicy: cfg.urgentPolicy }) : null), [profile, candidate, travelMin, cfg, nowMs, a, autoDeltaMin, bDeltaMin, urgent]);
  const save = (patch) => { if (typeof saveOpsim === 'function') saveOpsim({ parallelLab: { ...(settings && settings.opsim && settings.opsim.parallelLab) || {}, ...patch } }); };
  // 🌐 全体再計算(本物のエンジンを 待機/応援 の2回)。結果は版にも現場にも流さない(採用は別の操作)
  const [whole, setWhole] = useState(null);      // { running, error, cmp, counted, scenario, dataAtMs }
  const runWhole = async () => {
    if (typeof runRung !== 'function') { setWhole({ error: '全体再計算の口(runRung)がこの画面に渡っていません' }); return; }
    const { scenario, stayScenario, counted } = buildParallelLabScenario({ lots, cfg });
    setWhole({ running: true, counted });
    try {
      // 🚨 待機は 同じ条件で人だけ離れない(holdWorker)。採用が効いていてもこの2回はここで上書きする
      const stay = await runRung({ id: 'parallel-lab-stay', label: '待機', scenarioPatch: { parallelLab: stayScenario } });
      const release = await runRung({ id: 'parallel-lab-release', label: '応援', scenarioPatch: { parallelLab: scenario } });
      // 🚨 比較した時の条件(cfg)と指紋を固定して持つ。採用はこの固定した物から作る(その後 条件を触ったら門が閉じる)
      setWhole({ counted, scenario, cfg, fingerprint: adoptionFingerprint({ cfg, lots }), dataAtMs: Date.now(), cmp: compareWholePlans({ stay: stay && stay.simResult, release: release && release.simResult, lotLabel: labelOf }) });
    } catch (e) { setWhole({ error: e && e.message ? e.message : String(e), counted }); }
  };
  const nowFingerprint = useMemo(() => adoptionFingerprint({ cfg, lots }), [cfg, lots]);
  const blockers = whole && whole.cmp ? adoptionBlockers({ whole: whole.cmp, scenario: whole.scenario, stale: whole.fingerprint !== nowFingerprint }) : null;
  const adopt = () => {
    if (!blockers || !blockers.ok || typeof saveOpsim !== 'function') return;
    const applyFromMs = applyFrom ? new Date(applyFrom).getTime() : nowMs;
    const rec = buildAdoptionRecord({ cfg: whole.cfg, scenario: whole.scenario, lots, whole: whole.cmp, dataAtMs: whole.dataAtMs, nowMs: Date.now(), applyFromMs: Number.isFinite(applyFromMs) ? applyFromMs : nowMs });
    saveOpsim({ parallelLabAdoption: applyAdoption(settings && settings.opsim && settings.opsim.parallelLabAdoption, rec) });
    setAdoptMsg(`採用しました（版 ${rec.id}・適用 ${md(rec.applyFromMs)} から）。本番の割付が引き直ります`);
  };
  const revert = () => {
    if (typeof saveOpsim !== 'function') return;
    saveOpsim({ parallelLabAdoption: revertAdoption(settings && settings.opsim && settings.opsim.parallelLabAdoption, Date.now()) });
    setAdoptMsg('元へ戻しました（採用を外し、履歴に残しました）');
  };
  const cur = adoption.current;
  // 🚨 現場の指示は 採用した版の条件だけから(ラボで編集中の cfg は渡さない)
  const field = useMemo(() => (adopted && cur && result && result.base ? fieldInstructionsOf({ simResult: result.base, conditions: cur.conditions, nowMs }) : []), [adopted, cur, result, nowMs]);
  const stepId = a ? a.step.id : '';
  const tk = a && bLot && aZoneEff && bZoneEff ? travelKey(aZoneEff, bZoneEff) : '';
  const range = cmp && cmp.ok ? (() => { let lo = Infinity, hi = -Infinity; for (const k of PLAN_KEYS) for (const s of cmp.plans[k].segments) { lo = Math.min(lo, s.fromMs); hi = Math.max(hi, s.toMs); } return { fromMs: lo, toMs: hi }; })() : null;

  return (
    <details className={`rounded-xl border border-slate-300 bg-white ${open ? 'p-3' : 'px-3 py-0'}`} open={open} onToggle={(e) => setOpen(e.currentTarget.open)} data-parallel-lab="1">
      <summary className="min-h-11 py-2 cursor-pointer text-base font-bold">🧪 並列作業を試す（ラボ）{cur ? <span className="ml-2 rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">採用中 {cur.id}</span> : <span className="ml-2 text-xs font-normal text-slate-600">本番の割付や現場の指示には書きません</span>}</summary>
      {open && (
        <div className="mt-2 flex flex-col gap-3 text-sm">
          <p className="text-slate-700">自動運転中のロットAを離れてロットBを進めるのが、A・Bの完了・納期まで含めて得かを、同じ条件から3案で並べます。数字は根拠が揃った時だけ出ます。</p>
          {/* 🏭 現場へ見せる図(採用が効いている時だけ) */}
          {cur && (
            <div className="rounded-lg border-2 border-emerald-700 bg-emerald-50 p-2" data-parallel-lab-field="1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">🏭 現場へ（採用 {cur.id}・適用 {md(cur.applyFromMs)} から・比較のデータ {md(cur.basis.dataAtMs)}）</span>
                <span className="text-xs text-slate-700">工程: {cur.conditions.steps.map((s) => `${s.title}（終了対応 ${s.finishWorkMin}分・テンプレ ${(s.templateIds || []).length}種・品目コード ${(s.models || []).length}種）`).join('・')}／戻る余裕 {cur.conditions.returnMarginMin ?? '未登録'}分／緊急は{cur.conditions.urgentPolicy === 'returnable' ? '戻れるなら可' : '離れない'}／設備は{cur.conditions.equipmentHold === 'autoEnd' ? '自動の終わりで空く' : '終了対応が済むまで押さえる'}／待機との差: 納期超過 {cur.basis.stayLate}→{cur.basis.releaseLate}件・早く {cur.basis.earlier}・遅く {cur.basis.later}</span>
                {canEdit && <button type="button" className="min-h-11 rounded border border-slate-500 bg-white px-3" onClick={revert} data-parallel-lab-revert="1">↩ 元へ戻す（採用を外す）</button>}
              </div>
              {field.length === 0 && <p className="mt-1 text-xs text-slate-700">いまの割付に「自動の間に離れて戻る」場面はありません（自動の工程がまだ始まっていない、または人が空いていません）。</p>}
              <div className="mt-2 grid grid-cols-1 gap-2 lg:grid-cols-2">{field.slice(0, 6).map((fi) => <FieldCard key={fi.aJobId} fi={fi} lotLabel={labelOf} nowMs={nowMs} />)}</div>
            </div>
          )}
          {/* 📋 工程ごとの条件を一覧で登録 */}
          <details className="rounded-lg border border-slate-300 p-2" data-parallel-lab-list="1">
            <summary className="min-h-11 cursor-pointer font-bold">📋 工程ごとの条件を一覧で登録（自動運転の工程 {stepRows.length}種・場所の組 {zonePairs.length}）</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-slate-600"><th className="p-1">工程</th><th className="p-1">ロット</th><th className="p-1">品目コード（見本）</th><th className="p-1">自動</th><th className="p-1">離れてよい</th><th className="p-1">終了対応(分)</th></tr></thead>
                <tbody>{stepRows.map((r) => (
                  <tr key={r.stepId} className="border-t" data-parallel-lab-step-row={r.stepId}>
                    <td className="p-1 font-bold">{r.title}</td><td className="p-1">{r.lots}</td><td className="p-1 text-xs">{[...r.models].slice(0, 3).join('・')}{r.models.size > 3 ? ` 他${r.models.size - 3}` : ''}</td><td className="p-1">{r.autoSec ? `${Math.round(r.autoSec / 60)}分` : <span className="text-red-800">未登録</span>}</td>
                    <td className="p-1"><input type="checkbox" className="h-5 w-5" disabled={!canEdit} checked={cfg.mayLeave[r.stepId] === true} onChange={(e) => save({ mayLeave: { ...cfg.mayLeave, [r.stepId]: e.target.checked } })} /></td>
                    <td className="p-1"><input type="number" min="0" className={`${control} w-24`} disabled={!canEdit} value={cfg.finishWorkMin[r.stepId] ?? ''} onChange={(e) => save({ finishWorkMin: { ...cfg.finishWorkMin, [r.stepId]: e.target.value === '' ? null : Number(e.target.value) } })} /></td>
                  </tr>))}</tbody>
              </table>
              {zonePairs.length > 0 && (
                <table className="mt-2 w-full text-sm" data-parallel-lab-travel-table="1">
                  <thead><tr className="text-left text-xs text-slate-600"><th className="p-1">場所の組（片道）</th><th className="p-1">分</th></tr></thead>
                  <tbody>{zonePairs.map((k) => (
                    <tr key={k} className="border-t"><td className="p-1">{k.replace('|', ' ⇄ ')}</td><td className="p-1"><input type="number" min="0" className={`${control} w-24`} disabled={!canEdit} value={cfg.travelMin[k] ?? ''} onChange={(e) => save({ travelMin: { ...cfg.travelMin, [k]: e.target.value === '' ? null : Number(e.target.value) } })} /></td></tr>))}</tbody>
                </table>
              )}
              <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <label className="flex items-center gap-2">設備を離す時点 <select className={control} disabled={!canEdit} value={cfg.equipmentHold} onChange={(e) => save({ equipmentHold: e.target.value })} data-parallel-lab-equipment-hold="1"><option value="finish">終了対応が済むまで押さえる（品物が載ったまま）</option><option value="autoEnd">自動の終わりで空く（品物を外さず次を入れられる）</option></select></label>
                <label className="flex items-center gap-2">往復が未登録の組 <select className={control} disabled={!canEdit} value={cfg.unknownTravel} onChange={(e) => save({ unknownTravel: e.target.value })} data-parallel-lab-unknown-travel="1"><option value="count">足さずに数える（結果は暫定・採用は登録の後）</option><option value="exclude">その移動を伴う応援は割り付けない</option></select></label>
                <label className="flex items-center gap-2">戻る余裕（終了見込みの何分前） <input type="number" min="0" className={`${control} w-24`} disabled={!canEdit} value={cfg.returnMarginMin ?? ''} onChange={(e) => save({ returnMarginMin: e.target.value === '' ? null : Number(e.target.value) })} /> 分 <span className="text-xs text-slate-600">登録すると全体計算でも「収まる仕事だけ」取る。未登録＝待たせてよい（全体の納期で採点）</span></label>
                <label className="flex items-center gap-2">緊急ロットの扱い <select className={control} disabled={!canEdit} value={cfg.urgentPolicy} onChange={(e) => save({ urgentPolicy: e.target.value })}><option value="stay">離れない</option><option value="returnable">余裕を持って戻れるなら可</option></select></label>
              </div>
            </div>
          </details>
          <label className="flex flex-col gap-1"><span className="font-bold">ロットA（自動運転の工程）</span>
            <select className={control} value={aKey} onChange={(e) => setAKey(e.target.value)} data-parallel-lab-a="1">
              <option value="">— 選ぶ —</option>{aOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select></label>
          {a && !a.started && (
            <label className="flex flex-wrap items-center gap-2"><span>記録に自動の開始時刻がありません。試すなら開始時刻を指定:</span>
              <input type="time" className={control} value={assumedStartHM} onChange={(e) => setAssumedStartHM(e.target.value)} data-parallel-lab-assumed="1" />
              {assumedStartHM && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800">指定した時刻（記録ではありません）</span>}</label>
          )}
          <label className="flex flex-col gap-1"><span className="font-bold">ロットBの仕事（手作業・見立ての所要から）</span>
            <select className={control} value={bKey} onChange={(e) => setBKey(e.target.value)} data-parallel-lab-b="1">
              <option value="">— 選ぶ —</option>{bOptions.map((j) => { const l = lotById.get(String(j.lotId)); const st = l && Array.isArray(l.steps) ? l.steps.find((s) => String(s.id) === String(j.stepId)) : null; return <option key={j.jobId} value={j.jobId}>{`${(l && l.model) || j.model || ''}｜${(st && st.title) || j.processLabel || j.processKey}${j.unitIndex == null ? '' : ` ${j.unitIndex + 1}台目`} ${Math.round(j.durationMs / 60000)}分 指図${(l && l.orderNo) || ''}`}</option>; })}
            </select></label>
          {a && (
            <fieldset className="grid grid-cols-1 gap-2 rounded-lg border p-2 md:grid-cols-2" data-parallel-lab-conditions="1">
              <legend className="px-1 font-bold">最初に決める条件（settings.opsim.parallelLab に保存）</legend>
              <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" disabled={!canEdit} checked={cfg.mayLeave[stepId] === true} onChange={(e) => save({ mayLeave: { ...cfg.mayLeave, [stepId]: e.target.checked } })} />「{a.step.title}」は離れてよい（監視・即時対応が要らない）</label>
              <label className="flex items-center gap-2">終了後の人の対応 <input type="number" min="0" className={`${control} w-24`} disabled={!canEdit} value={cfg.finishWorkMin[stepId] ?? ''} onChange={(e) => save({ finishWorkMin: { ...cfg.finishWorkMin, [stepId]: e.target.value === '' ? null : Number(e.target.value) } })} /> 分</label>
              {bLot && <label className="flex flex-wrap items-center gap-2">往復（片道）
                {a.lot.mapZoneId ? <span>{str(a.lot.mapZoneId)}</span> : <select className={control} value={aZone} onChange={(e) => setAZone(e.target.value)} data-parallel-lab-zone="A"><option value="">Aの場所（未登録・指定）</option>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>}
                ⇄ {bLot.mapZoneId ? <span>{str(bLot.mapZoneId)}</span> : <select className={control} value={bZone} onChange={(e) => setBZone(e.target.value)} data-parallel-lab-zone="B"><option value="">Bの場所（未登録・指定）</option>{zones.map((z) => <option key={z} value={z}>{z}</option>)}</select>}
                <input type="number" min="0" className={`${control} w-24`} disabled={!canEdit || !tk} value={tk ? (cfg.travelMin[tk] ?? '') : ''} onChange={(e) => save({ travelMin: { ...cfg.travelMin, [tk]: e.target.value === '' ? null : Number(e.target.value) } })} /> 分
                {(!a.lot.mapZoneId || !bLot.mapZoneId) && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-bold text-amber-800">場所はロットに登録が無いので指定（記録ではありません）</span>}</label>}
              {bJob && <label className="flex items-center gap-2"><input type="checkbox" className="h-5 w-5" disabled={!canEdit} checked={cfg.interruptible[bJob.stepId] === true} onChange={(e) => save({ interruptible: { ...cfg.interruptible, [bJob.stepId]: e.target.checked } })} />Bの「{(bLot && bLot.steps && (bLot.steps.find((s) => String(s.id) === String(bJob.stepId)) || {}).title) || bJob.processKey}」は途中で止められる</label>}
              <div className="text-xs text-slate-600 md:col-span-2">戻る余裕 {cfg.returnMarginMin ?? '未登録'}分／緊急は{cfg.urgentPolicy === 'returnable' ? '余裕を持って戻れるなら可' : '離れない'}／設備は{cfg.equipmentHold === 'autoEnd' ? '自動の終わりで空く' : '終了対応が済むまで押さえる'}（上の「一覧で登録」で変えられます）</div>
            </fieldset>
          )}
          <div className="flex flex-wrap items-center gap-3" data-parallel-lab-shift="1">
            <span className="font-bold">時間が外れた場合（指定した変化で引き直す）</span>
            <label className="flex items-center gap-1">自動 <input type="number" className={`${control} w-20`} value={autoDeltaMin} onChange={(e) => setAutoDeltaMin(e.target.value)} /> 分（−で早く終わる）</label>
            <label className="flex items-center gap-1">Bの手作業 <input type="number" className={`${control} w-20`} value={bDeltaMin} onChange={(e) => setBDeltaMin(e.target.value)} /> 分（＋で長引く）</label>
          </div>
          {cmp && !cmp.ok && <ul className="list-disc pl-5 text-red-800" data-parallel-lab-missing="1">{cmp.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
          {cmp && cmp.ok && (
            <div className="flex flex-col gap-3" data-parallel-lab-result="1">
              <div className="rounded-lg bg-slate-900 p-3 text-base font-bold text-white">{cmp.summary.map((l) => <div key={l}>{l}</div>)}</div>
              {/* 🚨 設定による自動終了と 機械の実終了 は別物(第三者の指摘 2026-09-22 夜)。記録の duration = autoEndSec は「設定時間で記録が終わる仕組み」であって機械の終了信号ではない */}
              <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-xs text-slate-700 md:grid-cols-2" data-parallel-lab-auto-basis="1">
                <div>予定の自動時間: <b>{Math.round(profile.autoTotalMs / 60000)}分</b>（設定 autoEndSec）</div>
                <div>予定終了まで: <b>あと {Math.round(cmp.inputs.autoRemainMs / 60000)}分</b>{lotForA && lotForA.tasks[a.unit == null ? a.step.id : `${a.step.id}-${a.unit}`]?.assumed ? '（開始時刻は指定）' : `（記録の開始 ${hm(profile.autoStartMs)} から）`}{cmp.inputs.shift.autoDeltaMin ? `・指定した変化 ${cmp.inputs.shift.autoDeltaMin > 0 ? '+' : ''}${cmp.inputs.shift.autoDeltaMin}分` : ''}</div>
                <div>機械の実終了: <b>未確認</b>（機械から終了の信号は取っていません。予定で置いています）</div>
                <div>Bの所要 {Math.round(cmp.inputs.bWorkMs / 60000)}分（{candidate.workSource}）／片道 {travelMin}分／余裕 {cfg.returnMarginMin}分</div>
              </div>
              <label className="flex flex-wrap items-center gap-2" data-parallel-lab-clock="1"><span className="font-bold">🕒 共通の時計</span>
                <input type="range" min="0" max={Math.max(1, Math.ceil((range.toMs - range.fromMs) / 60000))} value={playMin} onChange={(e) => setPlayMin(Number(e.target.value))} className="h-11 w-64" />
                <span className="font-mono">{hm(range.fromMs + playMin * 60000)}</span><span className="text-xs text-slate-600">3案を同じ時刻で見る（機械の円は進み具合・人は移動中なら道の途中）</span></label>
              {PLAN_KEYS.map((k) => (
                <div key={k} className="rounded-lg border p-2" data-parallel-lab-plan={k}>
                  <div className="mb-1 font-bold">{cmp.plans[k].label}{cmp.plans[k].sameAsStay ? <span className="ml-2 text-xs font-normal text-slate-600">待機と同じ（{cmp.plans[k].why}）</span> : null}</div>
                  <Scene plan={cmp.plans[k]} tMs={range.fromMs + playMin * 60000} nowMs={nowMs} autoEndMs={cmp.autoEndMs} autoTotalMs={profile.autoTotalMs} />
                  {['worker', 'A', 'B'].map((who) => <Lane key={who} label={who === 'worker' ? '作業者' : who === 'A' ? 'ロットA' : 'ロットB'} segments={cmp.plans[k].segments.filter((s) => s.who === who)} fromMs={range.fromMs} toMs={range.toMs} />)}
                  <div className="mt-1 text-xs text-slate-600">A 完了 {hm(cmp.plans[k].aDoneMs)}{cmp.plans[k].bDoneMs ? `／B 完了 ${hm(cmp.plans[k].bDoneMs)}` : ''}／手待ち {Math.round(cmp.plans[k].score.idleMs / 60000)}分{cmp.plans[k].score.aWaitMs > 0 ? `／終了後の人待ち ${Math.round(cmp.plans[k].score.aWaitMs / 60000)}分` : ''}</div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2 text-xs">{Object.entries(KIND_LABEL).map(([k, l]) => <span key={k} className="inline-flex items-center gap-1"><span className={`inline-block h-3 w-4 rounded ${KIND_COLOR[k]}`} />{l}</span>)}</div>
            </div>
          )}
          {/* 🌐 全体で比べる → 悪化するロットを確認 → 採用 */}
          <div className="rounded-lg border border-slate-300 p-2" data-parallel-lab-whole="1">
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="min-h-11 rounded bg-slate-800 px-4 text-white disabled:opacity-40" disabled={!!(whole && whole.running)} onClick={runWhole}>{whole && whole.running ? '全体を計算中…' : '🌐 全体で比べる（登録した条件で 待機／応援 の2回、本物の割付を回す）'}</button>
              <span className="text-xs text-slate-600">結果は版にも現場の指示にも流れません（採用は下の別の操作）。</span>
            </div>
            {whole && whole.counted && <div className="mt-1 text-xs text-slate-600">自動運転の工程 {whole.counted.autoSteps}件のうち 条件(離れてよい・終了対応)が登録済み {whole.counted.eligible}件／場所の登録があるロット {whole.counted.lotsWithZone}件・無い {whole.counted.lotsWithoutZone}件（無い組は往復を足しません）</div>}
            {whole && whole.error && <p role="alert" className="text-red-800">{whole.error}</p>}
            {whole && whole.cmp && whole.cmp.ok && (
              <div className="mt-2 flex flex-col gap-2">
                {whole.cmp.provisional && <div className="rounded border-2 border-amber-600 bg-amber-50 p-2 font-bold text-amber-900" data-parallel-lab-provisional="1">⚠ 暫定の結果（往復が未登録の移動 {whole.cmp.delta.travelUnknown}回に時間を足していません）。採用は 往復を登録するか「除外」で引き直してから。</div>}
                <div className="rounded bg-slate-900 p-3 text-sm font-bold text-white" data-parallel-lab-whole-result="1">{whole.cmp.lines.map((l) => <div key={l}>{l}</div>)}</div>
                {whole.cmp.perLot.length > 0 && (
                  <table className="w-full text-sm" data-parallel-lab-perlot="1">
                    <thead><tr className="text-left text-xs text-slate-600"><th className="p-1">ロット</th><th className="p-1">完了の変化</th><th className="p-1">納期までの余裕 待機 → 応援</th><th className="p-1">印</th></tr></thead>
                    <tbody>{whole.cmp.perLot.slice(0, 12).map((p) => (
                      <tr key={p.lotId} className={`border-t ${p.crossed === 'late' || p.crossed === 'unfinished' ? 'bg-red-100' : p.deltaMs > 0 ? 'bg-amber-50' : 'bg-emerald-50'}`}>
                        <td className="p-1 font-bold">{labelOf(p.lotId)}</td><td className="p-1">{p.deltaText}</td>
                        <td className="p-1">{p.slackText}</td>
                        <td className="p-1 font-bold">{p.crossed === 'unfinished' ? '⚠ 期間内に終わらない' : p.crossed === 'late' ? '⚠ 納期超過へ' : p.crossed === 'saved' ? '間に合う' : p.crossed === 'finished' ? '終わるようになる' : p.deltaMs > 0 ? '遅くなる' : '早くなる'}</td>
                      </tr>))}</tbody>
                  </table>
                )}
                <div className="rounded-lg border border-emerald-700 p-2" data-parallel-lab-adopt="1">
                  <div className="font-bold">✅ 採用する条件を保存（対象の工程・離席可否・終了対応・移動時間・設備の解放時点・比較のデータの時点と待機との差・適用開始・版・戻す操作 を一緒に残す）</div>
                  {blockers && !blockers.ok && <ul className="list-disc pl-5 text-red-800" data-parallel-lab-adopt-blockers="1">{blockers.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1">適用開始 <input type="datetime-local" className={control} value={applyFrom || toLocalInput(nowMs)} onChange={(e) => setApplyFrom(e.target.value)} /></label>
                    <button type="button" className="min-h-11 rounded bg-emerald-700 px-4 font-bold text-white disabled:opacity-40" disabled={!canEdit || !blockers || !blockers.ok} onClick={adopt} data-parallel-lab-adopt-button="1">✅ この条件を採用（本番の割付へ）</button>
                    {cur && <span className="text-xs text-slate-700">いま採用中: {cur.id}（採用し直すと置き替わり、前の版は履歴に残ります）</span>}
                  </div>
                </div>
              </div>
            )}
            {whole && whole.cmp && !whole.cmp.ok && <ul className="list-disc pl-5 text-red-800">{whole.cmp.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
            {adoptMsg && <p className="mt-1 font-bold text-emerald-800" data-parallel-lab-adopt-msg="1">{adoptMsg}</p>}
            {adoption.history.length > 0 && <details className="mt-1 text-xs"><summary className="min-h-11 cursor-pointer">履歴 {adoption.history.length}件</summary><ul className="list-disc pl-5">{adoption.history.map((h) => <li key={h.id}>{md(h.adoptedAtMs)} {h.kind === 'revert' ? `↩ 戻す（${h.revertOf}）` : `✅ 採用 ${h.id}（適用 ${md(h.applyFromMs)}・工程 ${(h.conditions.steps || []).map((s) => s.title).join('・')}・納期超過 ${h.basis.stayLate}→${h.basis.releaseLate}）`}</li>)}</ul></details>}
          </div>
        </div>
      )}
    </details>
  );
}
