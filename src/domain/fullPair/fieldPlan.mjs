/** UI-independent, read-only field planning helpers. JST is explicit. */
import { DEFAULT_WORK_SCHEDULE } from '../workClock.js';
export const defaultHours = (schedule) => {
  const s = { ...DEFAULT_WORK_SCHEDULE, ...schedule };
  return { enabled: false, dates: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date()),
    start: s.dayStart, end: s.dayEnd,
    breaks: (s.breaks || []).filter(b => b.start < s.dayEnd && b.end > s.dayStart).map(b => ({
      start: b.start < s.dayStart ? s.dayStart : b.start,
      end: b.end > s.dayEnd ? s.dayEnd : b.end,
    })), allowAfterHoursAuto: false };
};
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const minutes = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '') ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : NaN;
export function workingContext({ dates = '', start = '08:00', end = '17:00', breakStart = '12:00', breakEnd = '13:00', breaks, allowAfterHoursAuto = false } = {}) {
  const days = [...new Set(dates.split(/[\s,、]+/).filter(Boolean))].sort();
  const errors = [], a = minutes(start), b = minutes(end);
  if (!days.length || days.length > 14 || days.some(day => !validDate(day))) errors.push('勤務日は YYYY-MM-DD で1〜14日指定してください');
  if (!(a < b)) errors.push('始業・終業を確認してください（日をまたぐ勤務は未対応）');
  // Legacy single-break callers remain supported; the UI supplies all registered breaks.
  const spans = (breaks ?? (breakStart || breakEnd ? [{ start: breakStart, end: breakEnd }] : []))
    .map(v => [minutes(v.start), minutes(v.end)]).sort((x, y) => x[0] - y[0]);
  if (spans.some(([c, d], i) => !(a <= c && c < d && d <= b) || (i > 0 && spans[i - 1][1] > c))) errors.push('休憩は勤務時間内で重ならない開始・終了を指定してください');
  if (errors.length) return { errors, workerWindows: [] };
  const startAt = `${days[0]}T${start}:00+09:00`, epoch = Date.parse(startAt);
  const workerWindows = days.flatMap(day => {
    const offset = (Date.parse(`${day}T00:00:00+09:00`) - epoch) / 60000;
    const segments = []; let cursor = a;
    for (const [c, d] of spans) { if (cursor < c) segments.push([cursor, c]); cursor = d; }
    if (cursor < b) segments.push([cursor, b]);
    return segments.map(([x, y]) => [offset + x, offset + y]);
  });
  return { errors, workerWindows, startAt, autoOutsideWindows: allowAfterHoursAuto === true, origin: `${days[0]} ${start}（日本時間）` };
}

export function timeLabel(offset, input) {
  if (!Number.isFinite(offset)) return '—';
  if (!input?.startAt) return `開始後${Number(offset.toFixed(1))}分`;
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Date.parse(input.startAt) + offset * 60000));
}

/** Diverse queue, not a result ranking. All scores here are selection heuristics;
 * only completed full simulations may be displayed as savings. */
export function partnerQueue(a, candidates) {
  const byDistance = [...candidates].sort((x, y) => (x.travel.min ?? Infinity) - (y.travel.min ?? Infinity));
  const fit = x => {
    const manual = x.r.times.filter(t => !t.auto && Number.isFinite(t.sec)).reduce((n, t) => n + t.sec / 60, 0);
    const auto = a.times.filter(t => t.auto && Number.isFinite(t.sec)).reduce((n, t) => Math.max(n, t.sec / 60), 0);
    return Math.abs(auto - manual - 2 * (x.travel.min ?? 1e6));
  };
  const byFit = [...candidates].sort((x, y) => fit(x) - fit(y));
  const byIdle = [...candidates].sort((x, y) => (y.r.sched.idleMin || 0) - (x.r.sched.idleMin || 0));
  const out = [], seen = new Set();
  for (let i = 0; i < candidates.length; i++) for (const list of [byFit, byDistance, byIdle]) {
    const item = list[i];
    if (item && !seen.has(item.r.id)) { seen.add(item.r.id); out.push(item); }
  }
  return out;
}

export function workerActions(plan) {
  const jobs = new Map(plan.jobs.map(j => [j.id, j]));
  return plan.worker.filter(e => e.kind !== 'idle').map(e => {
    const j = jobs.get(e.jobId);
    const target = j ? `${j.lotId} ${j.unit == null ? 'ロット共通' : `${j.unit + 1}台目`} ${j.label || j.stepId}` : '';
    return { ...e, action: e.kind === 'travel' ? `${e.from} → ${e.to}へ移動` : `${target}${e.kind === 'launch' ? 'を自動開始' : e.kind === 'monitor' ? 'を監視' : ''}`,
      autoEnd: e.kind === 'launch' ? j.end : null };
  });
}

export function travelScenarios(input, options) {
  const [a, b] = input.lots.map(l => l.location);
  const current = input.travel?.[a]?.[b];
  const reverse = input.travel?.[b]?.[a];
  if (a === b || !Number.isFinite(current) || !Number.isFinite(reverse)) return [];
  const duration = min => `${Number((min * 60).toFixed(1))}秒`;
  return [0, 1, 3].map(extra => ({
    key: String(extra),
    label: `${extra === 0 ? '現在' : `片道＋${extra}分`}（往き${duration(current + extra)}・帰り${duration(reverse + extra)}）`,
    // Keep asymmetric routes and routes from other starting locations. The first
    // row must be exactly the same problem/search as the main comparison.
    input: { ...input, travel: { ...input.travel,
      [a]: { ...input.travel[a], [b]: current + extra },
      [b]: { ...input.travel[b], [a]: reverse + extra },
    } },
    options,
  }));
}
