// =============================================================================
//  opsim/fullPair/pairPicture.mjs — 並列シミュの結果を「絵」にするための並べ替えだけ(純関数・2026-09-27)
// -----------------------------------------------------------------------------
//  清水さん(2026-09-27): 「文字だらけでがっかり・ChatGPT がかっこいい画面を一回作ってたのに」
//  → 計算(domain/fullPair/scheduler.mjs・domain/parallelLab/fullPairInput.js)の結果を、そのまま帯と棒の形に並べ直す。
//    ここでは数字を作らない・丸めない(描く位置の割合だけ出す)。計算の入力にも触らない。
// =============================================================================

const str = (v) => (v == null ? '' : String(v)).trim();
const DONE = new Set(['completed', 'skipped', 'rework-done']);
const taskOf = (tasks, step, idx, key) => (tasks && (tasks[`${str(step && step.id)}-${key}`] || tasks[`${idx}-${key}`])) || null;
const stateOf = (t) => {
  const s = str(t && t.status);
  if (!s || s === 'waiting' || s === 'pending') return 'todo';
  return DONE.has(s) ? 'done' : 'running';
};

/**
 * 1ロットの工程を 左から順に並べた札(止まった時の絵に使う)。
 * @param {{ label?:string, lot:object, times:Array }} row
 * @returns {{ label:string, units:number, steps:Array<{ idx, title, min:number|null, auto, machine, lotOnce, done, running, todo }> }}
 */
export function stepStripOf(row) {
  const lot = (row && row.lot) || {};
  const steps = Array.isArray(lot.steps) ? lot.steps : [];
  const tasks = lot.tasks && typeof lot.tasks === 'object' ? lot.tasks : {};
  const q = Math.max(1, Math.floor(Number(lot.quantity)) || 1);
  return {
    label: str(row && row.label) || str(lot.id),
    units: q,
    steps: steps.map((s, idx) => {
      const t = ((row && row.times) || [])[idx] || null;
      const once = !!(t ? t.lotOnce : s && s.lotOnce);
      const states = once
        ? [Object.keys(tasks).filter((k) => k.startsWith(`${str(s && s.id)}-lot-`) || k.startsWith(`${idx}-lot-`)).map((k) => stateOf(tasks[k]))
          .reduce((a, b) => (a === 'done' || b === 'done' ? 'done' : a === 'running' || b === 'running' ? 'running' : 'todo'), 'todo')]
        : Array.from({ length: q }, (_, u) => stateOf(taskOf(tasks, s, idx, u)));
      return {
        idx, title: str(t && t.title) || str(s && s.title) || `工程${idx + 1}`,
        min: t && Number.isFinite(t.sec) ? t.sec / 60 : null,
        auto: !!(t && t.auto), machine: !!(t && (t.auto || t.machine)), lotOnce: once,
        done: states.filter((x) => x === 'done').length, running: states.filter((x) => x === 'running').length, todo: states.filter((x) => x === 'todo').length,
      };
    }),
  };
}

/** A と B の札をまとめて(候補に持たせる) */
export const stepStripsOf = (rowA, rowB) => ({ A: stepStripOf(rowA), B: stepStripOf(rowB) });

/**
 * 止まった理由(文)を 絵のどこに赤い印を付けるかへ振り分ける。文はそのまま残す(言い換えない)。
 * @returns {{ steps:{A:Object<number,string[]>,B:Object<number,string[]>}, lots:{A:string[],B:string[]}, travel:string[], general:string[] }}
 */
export function problemsOf(errors, strips) {
  const out = { steps: { A: {}, B: {} }, lots: { A: [], B: [] }, travel: [], general: [] };
  const mark = (key, idx, why) => {
    const list = out.steps[key][idx] || (out.steps[key][idx] = []);
    if (!list.includes(why)) list.push(why);
  };
  for (const raw of errors || []) {
    const m = str(raw);
    const lotKey = /^(A|B)(:|に|の)/.exec(m)?.[1] || null;
    const strip = lotKey && strips ? strips[lotKey] : null;
    const open = (s) => s.todo + s.running > 0;
    let placed = false;
    if (lotKey && strip) {
      const quoted = [...m.matchAll(/「([^」]+)」/g)].map((x) => x[1]);
      if (quoted.length) {
        strip.steps.forEach((s) => { if (quoted.includes(s.title)) { mark(lotKey, s.idx, '機械を使うか未確認'); placed = true; } });
      } else if (/時間が分からない/.test(m)) {
        strip.steps.forEach((s) => { if (s.min == null && open(s)) { mark(lotKey, s.idx, '時間が分からない'); placed = true; } });
      } else if (/ロット共通工程の途中・不良/.test(m)) {
        strip.steps.forEach((s) => { if (s.lotOnce && s.running) { mark(lotKey, s.idx, '途中か不良'); placed = true; } });
      } else if (/作業中・停止中・不良/.test(m)) {
        strip.steps.forEach((s) => { if (!s.lotOnce && s.running) { mark(lotKey, s.idx, '途中か不良'); placed = true; } });
      }
    }
    if (placed) continue;
    if (/片道|場所|区画|固定設備/.test(m)) out.travel.push(m);
    else if (lotKey) out.lots[lotKey].push(m.replace(/^(A|B):\s*/, ''));
    else out.general.push(m);
  }
  return out;
}

/** 目盛りの幅(分)。8本以下になる一番細かい幅 */
export function tickStepOf(horizon) {
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 90, 120, 180, 240, 360, 480, 720, 1440, 2880, 5760];
  return steps.find((s) => horizon / s <= 8) || Math.ceil(horizon / 8);
}

/**
 * 時間の帯(ガント)の行: 作業者 / 機械ごと。計算の結果(plan)をそのまま並べ直すだけ。
 * kind: manual 手作業 / auto 自動測定 / monitor 自動をそばで見る / travel 移動 / idle 人の待ち / hold 機械が人を待つ / launch 自動を始めた点
 */
export function ganttRowsOf(plan, input) {
  const jobs = (plan && plan.jobs) || [];
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const tag = (lotId, unit) => `${lotId || ''}${unit == null ? '' : unit + 1}`;
  const worker = ((plan && plan.worker) || []).filter((e) => e.end > e.start || e.kind === 'launch').map((e) => {
    const j = e.jobId ? byId.get(e.jobId) : null;
    return { kind: e.kind, lotId: e.lotId || (j && j.lotId) || null, start: e.start, end: e.end,
      text: e.kind === 'travel' ? '移動' : e.kind === 'idle' ? '' : tag(j ? j.lotId : e.lotId, j ? j.unit : null),
      title: e.kind === 'travel' ? `${e.from} → ${e.to}` : j ? `${tag(j.lotId, j.unit)} ${j.label || ''}` : '' };
  });
  const lotOrder = ((input && input.lots) || []).map((l) => l.id);
  const resources = [];
  for (const id of lotOrder) for (const j of jobs) if (j.lotId === id && j.resourceId && !resources.includes(j.resourceId)) resources.push(j.resourceId);
  for (const j of jobs) if (j.resourceId && !resources.includes(j.resourceId)) resources.push(j.resourceId);
  const rows = [{ id: 'worker', label: '作業者', segs: worker }];
  for (const r of resources) {
    const segs = jobs.filter((j) => j.resourceId === r).map((j) => ({ kind: j.kind === 'auto' ? 'auto' : 'manual', lotId: j.lotId, start: j.start, end: j.end,
      text: tag(j.lotId, j.unit), title: `${tag(j.lotId, j.unit)} ${j.label || ''}` }));
    for (const w of (plan && plan.resourceWait) || []) if (w.resourceId === r && w.end > w.start) segs.push({ kind: 'hold', lotId: null, start: w.start, end: w.end, text: '', title: '機械に載せたまま 人を待つ' });
    rows.push({ id: r, label: r, segs: segs.sort((a, b) => a.start - b.start) });
  }
  const first = [...jobs].sort((a, b) => a.start - b.start)[0];
  return { rows, total: plan && plan.metrics ? plan.metrics.totalMin : 0, lotEnds: (plan && plan.metrics && plan.metrics.lotEnds) || {}, firstLot: first ? first.lotId : null };
}
