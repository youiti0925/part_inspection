/* ============================================================================
 * 今日決めること（上から3つ）＋ 遅れる・止まるロットの理由の表（2026-09-23）
 * ----------------------------------------------------------------------------
 * 帯（黒い結論の段）の中に置く。閉じている時は 3枚の札だけ（段の高さを増やさない）。
 * 「理由の表」を押すと、同じ段の中に全幅で 理由ごとの棒 が開く（押した時だけ下を押す）。
 * 🚨 数は todayDecisionsOf ただ1本から（ここで数えない）。
 * 🚨 押しても何も確定しない。ロットの札を押すと そのロットの詳しい所が開くだけ。
 * ⚠ 製品・最終で同じ中身（md5 の対）。片方だけ直さない。
 * ========================================================================== */
import React from 'react';

const TONE = Object.freeze({
  rose: { chip: 'border-rose-300 bg-rose-50 text-rose-900', bar: 'bg-rose-500', dot: 'bg-rose-600 text-white' },
  pink: { chip: 'border-pink-300 bg-pink-50 text-pink-900', bar: 'bg-pink-500', dot: 'bg-pink-600 text-white' },
  violet: { chip: 'border-violet-300 bg-violet-50 text-violet-900', bar: 'bg-violet-500', dot: 'bg-violet-600 text-white' },
  sky: { chip: 'border-sky-300 bg-sky-50 text-sky-900', bar: 'bg-sky-500', dot: 'bg-sky-600 text-white' },
  amber: { chip: 'border-amber-300 bg-amber-50 text-amber-900', bar: 'bg-amber-500', dot: 'bg-amber-500 text-white' },
  slate: { chip: 'border-slate-300 bg-slate-100 text-slate-800', bar: 'bg-slate-500', dot: 'bg-slate-600 text-white' },
});
const toneOf = (t) => TONE[t] || TONE.slate;
const fmt = (n) => Number(n || 0).toLocaleString('ja-JP');
const pctOf = (n, max) => (max > 0 ? Math.max(4, Math.round((n / max) * 100)) : 0);

/**
 * @param {{ model: {rows:any[], total:number, top:any[], max:number}|null,
 *           lotLabelOf?: (id:string)=>{main:string, sub?:string}|null,
 *           onPickLot?: (id:string)=>void, maxLots?: number }} props
 */
export default function TodayDecisions({ model = null, lotLabelOf = null, onPickLot = null, maxLots = 24 }) {
  const [open, setOpen] = React.useState(false);
  const [focusKey, setFocusKey] = React.useState(null);
  const rows = model && Array.isArray(model.rows) ? model.rows : [];
  if (!rows.length) return null;
  const top = Array.isArray(model.top) ? model.top : rows.slice(0, 3);
  const max = Number(model.max) || 0;
  const pick = (key) => {
    if (open && focusKey === key) { setOpen(false); return; }
    setFocusKey(key); setOpen(true);
  };
  const labelOf = (id) => {
    const l = typeof lotLabelOf === 'function' ? lotLabelOf(id) : null;
    return l && l.main ? l : { main: String(id), sub: '' };
  };
  return (
    <>
      <span className="ml-auto flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" data-today-decisions={String(top.length)}>
        <span className="text-2xs font-black text-amber-300" title="遅れる・止まるロットを 理由ごとに数え、多い順に3つ。数は「その理由で遅れる・止まるロットの数」です(外した後の計算ではありません)">今日決めること</span>
        {top.map((r, i) => {
          const t = toneOf(r.tone);
          const on = open && focusKey === r.key;
          return (
            <button
              key={r.key}
              type="button"
              data-today-decision={r.key}
              aria-expanded={on}
              onClick={() => pick(r.key)}
              title={`${r.why}。関わるロット ${fmt(r.n)}件(押すと理由の表が開きます。何も確定しません)`}
              className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-1.5 text-2xs font-black ${t.chip} ${on ? 'ring-2 ring-amber-300' : ''}`}
            >
              <span aria-hidden="true" className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-2xs ${t.dot}`}>{i + 1}</span>
              <span className="whitespace-nowrap">{r.verb}</span>
              <span aria-hidden="true" className="inline-flex h-2 w-8 overflow-hidden rounded-full bg-white/70">
                <span className={`h-full rounded-full ${t.bar}`} style={{ width: `${pctOf(r.n, max)}%` }} />
              </span>
              <b className="tabular-nums">{fmt(r.n)}</b>
            </button>
          );
        })}
        <button
          type="button"
          data-today-decisions-table-toggle=""
          aria-expanded={open}
          onClick={() => { setFocusKey(null); setOpen((v) => !v); }}
          className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-slate-600 px-2 text-2xs font-bold text-slate-200 hover:bg-slate-800"
          title="遅れる・止まるロットを、理由ごとの棒で全部見る"
        >
          {open ? '▴ 閉じる' : `▾ 理由の表(${fmt(model.total)}件)`}
        </button>
      </span>
      {open ? (
        <div className="basis-full" data-today-decisions-table="">
          <div className="my-1.5 rounded-xl bg-white p-3 text-slate-900 shadow-lg">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span className="text-sm font-black">遅れる・止まる・納期が合わないロットの理由</span>
              <span className="text-2xs text-slate-500">
                合計 <b className="tabular-nums text-slate-800">{fmt(model.total)}</b>件。1件は理由1つにだけ入れています(足すと合計)。棒の長さ＝関わるロットの数。外した後の計算ではありません。
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {rows.map((r, i) => {
                const t = toneOf(r.tone);
                const focused = focusKey === r.key;
                const shown = r.lotIds.slice(0, maxLots);
                const rest = r.lotIds.length - shown.length;
                return (
                  <li key={r.key} data-today-decision-row={r.key} className={`rounded-lg border px-2 py-1 ${focused ? 'border-amber-400 bg-amber-50/60' : 'border-slate-200'}`}>
                    <button
                      type="button"
                      onClick={() => setFocusKey(focused ? null : r.key)}
                      aria-expanded={focused}
                      className="grid min-h-11 w-full grid-cols-[1.5rem_minmax(0,16rem)_minmax(0,1fr)_3.5rem] items-center gap-2 text-left"
                    >
                      <span aria-hidden="true" className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-2xs font-black ${i < 3 ? t.dot : 'bg-slate-200 text-slate-600'}`}>{i + 1}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-black">{r.verb}</span>
                        <span className="block truncate text-2xs text-slate-500">{r.why}</span>
                      </span>
                      <span className="h-3 overflow-hidden rounded-full bg-slate-100">
                        <span className={`block h-full rounded-full ${t.bar}`} style={{ width: `${pctOf(r.n, max)}%` }} />
                      </span>
                      <span className="text-right text-sm font-black tabular-nums">{fmt(r.n)}<span className="text-2xs font-bold text-slate-500">件</span></span>
                    </button>
                    {focused ? (
                      <div className="flex flex-wrap gap-1 pb-1 pl-8 pt-1">
                        {shown.map((id) => {
                          const l = labelOf(id);
                          return (
                            <button
                              key={id}
                              type="button"
                              data-today-decision-lot={id}
                              onClick={() => { if (typeof onPickLot === 'function') onPickLot(id); }}
                              className={`inline-flex min-h-11 max-w-[16rem] flex-col items-start justify-center rounded-md border px-2 text-left ${t.chip}`}
                              title="押すと このロットの詳しい所が開きます"
                            >
                              <span className="max-w-full truncate text-xs font-black">{l.main}</span>
                              {l.sub ? <span className="max-w-full truncate text-2xs opacity-80">{l.sub}</span> : null}
                            </button>
                          );
                        })}
                        {rest > 0 ? <span className="self-center text-2xs font-bold text-slate-500">ほか {fmt(rest)}件</span> : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
