// =============================================================================
//  src/opsim/idleTone.js — 空きの理由の色（部品ではない定数。IdleStrip / PersonDay / DueCalendar が共有）
// -----------------------------------------------------------------------------
//  🚨 「記録が無い工程が待っている（スキル側）」と「仕事が無い（仕事側）」は必ず違う色。
//     清水さん（2026-09-03）の問い「仕事が全くないのかスキルがないのか」に色で答える為。
// =============================================================================
import { IDLE_KIND } from '../domain/operationsSimulation/idleReason.js';

export const KIND_TONE = Object.freeze({
  [IDLE_KIND.SKILL]: { bar: 'bg-amber-500', text: 'text-amber-700', border: 'border-amber-400', bg: 'bg-amber-50' },
  [IDLE_KIND.NO_JOB]: { bar: 'bg-slate-400', text: 'text-slate-600', border: 'border-slate-400', bg: 'bg-slate-100' },
  [IDLE_KIND.ARRIVAL]: { bar: 'bg-sky-400', text: 'text-sky-700', border: 'border-sky-400', bg: 'bg-sky-50' },
  [IDLE_KIND.PREV_STEP]: { bar: 'bg-sky-300', text: 'text-sky-700', border: 'border-sky-300', bg: 'bg-sky-50' },
  [IDLE_KIND.RESERVED]: { bar: 'bg-violet-400', text: 'text-violet-700', border: 'border-violet-400', bg: 'bg-violet-50' },
  [IDLE_KIND.EQUIPMENT]: { bar: 'bg-slate-500', text: 'text-slate-700', border: 'border-slate-500', bg: 'bg-slate-100' },
  // 🏭 作業する場所が埋まっている。「仕事が無い(灰)」「記録が無い(琥珀)」のどちらでもないので
  //   別の色にする。灰へ寄せると、清水さんの問い（仕事が無いのか／スキルが無いのか）に
  //   当てはまらない3つ目の理由が、画面の上で「仕事が無い」に見えてしまう。
  [IDLE_KIND.ZONE]: { bar: 'bg-teal-500', text: 'text-teal-700', border: 'border-teal-500', bg: 'bg-teal-50' },
  // 👥 2026-09-10 同じ台を続ける人の手が空くのを待っている（分担の区切りを「1台は同じ人」にした時）。
  //   場所待ち(teal)とも「仕事が無い(灰)」とも別の色。灰へ寄せると、仕事も技能も在るのに
  //   「仕事が無い」に見えてしまう。
  [IDLE_KIND.HANDOFF]: { bar: 'bg-fuchsia-500', text: 'text-fuchsia-700', border: 'border-fuchsia-500', bg: 'bg-fuchsia-50' },
  // 📋 2026-09-22 保存した計画で別の人に決まっている。仕事も技能も在るので 灰(仕事が無い)へ寄せない。
  [IDLE_KIND.PLAN_FIXED]: { bar: 'bg-indigo-500', text: 'text-indigo-700', border: 'border-indigo-500', bg: 'bg-indigo-50' },
  [IDLE_KIND.NO_TIME]: { bar: 'bg-slate-500', text: 'text-slate-700', border: 'border-slate-500', bg: 'bg-slate-100' },
  [IDLE_KIND.UNEXPLAINED]: { bar: 'bg-slate-500', text: 'text-slate-700', border: 'border-slate-500', bg: 'bg-slate-100' },
  [IDLE_KIND.UNAVAILABLE]: { bar: 'bg-slate-200', text: 'text-slate-500', border: 'border-slate-300', bg: 'bg-slate-50' },
});
export const toneOfKind = (kind) => KIND_TONE[kind] || KIND_TONE[IDLE_KIND.UNEXPLAINED];

/** 休みの列・休憩の網掛け（CSS だけ。px を使わない）。 */
export const OFF_HATCH = Object.freeze({
  backgroundImage: 'repeating-linear-gradient(135deg, rgba(148,163,184,0.25) 0, rgba(148,163,184,0.25) 0.125rem, transparent 0.125rem, transparent 0.5rem)',
});
