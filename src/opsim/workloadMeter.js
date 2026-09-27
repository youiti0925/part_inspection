// 表示の座標だけを作る。工数・不足・人員数は計算しない。
export const measured = value => {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
export function workloadGeometry(required, capacity) {
  const need = measured(required), available = measured(capacity);
  const max = Math.max(need ?? 0, available ?? 0);
  const percent = v => v == null ? null : max === 0 ? 0 : v / max * 100;
  return { need: percent(need), capacity: percent(available),
    within: need == null ? null : percent(available == null ? need : Math.min(need, available)),
    excess: need == null || available == null ? null : percent(Math.max(0, need - available)),
    state: need == null || available == null ? 'unknown' : need > available ? 'over' : 'within',
  };
}
export function evidenceGeometry(have, need) {
  const current = measured(have), target = measured(need);
  if (current == null || target == null) return {state:'unknown',percent:null,current,target};
  if (target === 0) return {state:'not-required',percent:null,current,target};
  return {state:current >= target ? 'reached':'pending',percent:Math.min(100,current/target*100),current,target};
}
