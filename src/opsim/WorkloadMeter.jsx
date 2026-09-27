import React from 'react';
import { workloadGeometry } from './workloadMeter.js';

/** 同じ行の2本は同じ目盛。青は仕事量であって、納期内に終わる判定ではない。 */
export function WorkloadMeter({ required, capacity, requiredLabel, capacityLabel, label = '要る時間と働ける時間' }) {
  const g = workloadGeometry(required, capacity);
  return <div className="grid min-w-0 gap-2 rounded-xl border border-slate-200 bg-white p-3" data-workload-state={g.state} role="group" aria-label={label}>
    <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
      <span className="text-xs font-bold text-slate-700">要る時間</span>
      <span className="text-right text-sm font-black tabular-nums text-slate-900">{g.need == null ? '未確認' : (requiredLabel ?? '未確認')}</span>
      <div className="col-span-2 relative h-3 overflow-hidden rounded bg-slate-100" aria-hidden="true">
        {g.need == null ? <div className="h-full rounded border border-dashed border-slate-400" /> : <>
          <div className="absolute inset-y-0 left-0 bg-sky-700" style={{width: `${g.within}%`}} />
          {g.excess > 0 ? <div className="absolute inset-y-0 bg-rose-600" style={{left: `${g.within}%`,width: `${g.excess}%`,backgroundImage:'repeating-linear-gradient(135deg,transparent 0 .3rem,rgba(255,255,255,.45) .3rem .45rem)'}} /> : null}
        </>}
      </div>
      <span className="text-xs font-bold text-slate-700">働ける時間</span>
      <span className="text-right text-sm font-black tabular-nums text-slate-900">{g.capacity == null ? '未確認' : (capacityLabel ?? '未確認')}</span>
      <div className="col-span-2 h-3 rounded bg-slate-100" aria-hidden="true">
        {g.capacity == null ? <div className="h-full rounded border border-dashed border-slate-400" /> : g.capacity === 0 ? null : <div className="h-full rounded border-2 border-slate-600 bg-slate-200" style={{width: `${g.capacity}%`}} />}
      </div>
    </div>
    <span className="text-xs text-slate-600">{g.state === 'unknown' ? '点線：時間をまだ確認できません' : g.state === 'over' ? '赤い斜線：働ける時間を越える分' : '2本は同じ目盛。仕事の集中や納期は別に確認します'}</span>
  </div>;
}
