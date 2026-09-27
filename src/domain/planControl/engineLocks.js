import { taskKey } from './planControl.js';

export function jobLocksOf(plan, live, freezeBeforeMs) {
  return Object.fromEntries(plan.tasks.filter(t => t.assignment && live[t.key] !== 'completed'
    && (['prepared', 'processing'].includes(live[t.key]) || t.assignment.startMs < freezeBeforeMs))
    .map(t => [t.key, { worker: t.assignment.worker, partner: t.assignment.partner }]));
}

// No locks means byte-for-byte legacy scheduling. Never expand eligibility.
export function lockOf(job, locks) {
  if (!locks) return null;
  const lock = locks[taskKey(job)];
  if (!lock) return null;
  if (typeof lock.worker !== 'string' || !lock.worker || (lock.partner !== null && typeof lock.partner !== 'string')) throw new Error('保存計画の担当固定を読めません');
  return lock;
}
