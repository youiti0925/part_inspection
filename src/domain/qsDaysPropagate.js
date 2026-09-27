// 🧾➡📋 P109 品質規格の日数を直した時の波及の計画(部品だけの純関数)。
//   部品の品質規格は1つの規格を複数の品目コードで共有するので、その規格を指す品目コードごとに製品と対の planMasterChangeUpdates を呼び、1つにまとめる。
import { planMasterChangeUpdates } from './modelMasterPropagate.js';

/** 規格 standardId × テンプレ templateId の日数を before → after にした時の計画(品目コードをまたいでまとめる)。 */
export function planQsDaysChange({ standardId, templateId, before, after, lots, modelStandardMap, calendar, defaultEntryDaysBefore, entryHHMM, defaultShipDaysBefore }) {
  const models = Object.keys(modelStandardMap || {}).filter(m => modelStandardMap[m] === standardId);
  const out = { models, updates: [], skipped: [], counts: { updates: 0, dueChange: 0, entryChange: 0, skipped: 0, completedIgnored: 0 } };
  const seen = new Set();
  for (const model of models) {
    const p = planMasterChangeUpdates({ model, templateId: templateId || '', before, after, lots, calendar, defaultEntryDaysBefore, entryHHMM, defaultShipDaysBefore });
    for (const u of p.updates) { if (seen.has(u.lotId)) continue; seen.add(u.lotId); out.updates.push(u); }
    for (const s of p.skipped) { if (seen.has(s.lotId)) continue; seen.add(s.lotId); out.skipped.push(s); }
    out.counts.completedIgnored += (p.counts && p.counts.completedIgnored) || 0;
  }
  out.counts.updates = out.updates.length;
  out.counts.dueChange = out.updates.filter(u => u.dueChange).length;
  out.counts.entryChange = out.updates.filter(u => u.entryChange).length;
  out.counts.skipped = out.skipped.length;
  return out;
}
