import React from 'react';
import { ganttRowsOf, problemsOf, tickStepOf } from './pairPicture.mjs';

/* 🖼 2026-09-27 並列シミュの結果を「絵」で見せる部品。清水さん「文字だらけでがっかり・ChatGPT がかっこいい画面を一回作ってたのに」
     文字を消しても分かる事を合格の基準にする:
       ① 短くなる分 = 大きな数字と、1ロットずつ / 掛け持ち の2本の棒(同じ縮尺)
       ② 時間の帯 = 横が時刻、縦が 作業者・Aの機械・Bの機械。手作業・自動測定・移動・待ちを色で分ける。2本を上下に同じ縮尺で
       ③ 止まった時 = 工程の札を並べ、どの工程がなぜ止めたかを赤い印で
       ④ 前提 = 図の横に小さな札
     数字は計算の結果(scheduler.mjs)をそのまま。ここで作らない。色は tailwind の色(縞だけ同じ色の値を直に書く)。 */

const n = (v) => (Number.isFinite(v) ? Number(v.toFixed(1)) : '—');
const pct = (v, h) => `${Math.max(0, Math.min(100, (v / (h || 1)) * 100))}%`;
const stripe = (a, b) => ({ backgroundImage: `repeating-linear-gradient(135deg, ${a} 0 4px, ${b} 4px 8px)` });

const KIND = {
  manual: { word: '手作業', cls: 'bg-emerald-500 text-white' },
  auto: { word: '自動測定', cls: 'bg-sky-400 text-slate-900' },
  monitor: { word: '自動をそばで見る', cls: 'bg-violet-400 text-white' },
  travel: { word: '移動', cls: 'bg-amber-400 text-slate-900' },
  idle: { word: '人の待ち', cls: 'bg-slate-200 text-slate-600' },
  hold: { word: '機械が人を待つ', cls: 'text-rose-900', style: stripe('#fb7185', '#ffe4e6') },
};
const LOT_DOT = { A: 'bg-indigo-700 text-white', B: 'bg-pink-600 text-white' };
const LotDot = ({ id, className = '' }) => (
  <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-black ${LOT_DOT[id] || 'bg-slate-700 text-white'} ${className}`}>{id}</span>
);

export function Legend({ kinds = ['manual', 'auto', 'monitor', 'travel', 'idle', 'hold'] }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-700" data-pair-legend="1">
      {kinds.map((k) => <span key={k} className="inline-flex items-center gap-1"><i className={`inline-block h-3 w-5 rounded-sm ${KIND[k].cls}`} style={KIND[k].style} />{KIND[k].word}</span>)}
    </div>
  );
}

/** ① 短くなる分: 大きな数字 + 2本(3本)の棒。棒の上の ⒶⒷ は そのロットが全部終わる時刻 */
export function SavingHero({ r, input }) {
  const base = r.baseline.metrics, paired = r.paired.metrics, alt = r.excludedAlternative;
  const horizon = Math.max(base.totalMin, paired.totalMin, alt ? alt.plan.metrics.totalMin : 0);
  const saved = r.savingsMin > 0;
  const tone = saved ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50';
  const bar = (key, label, m, cls, extra = null) => (
    <div className="flex items-center gap-2" data-pair-bar={key}>
      <div className="w-20 shrink-0 text-right text-xs font-bold leading-tight text-slate-700 sm:w-24 sm:text-sm">{label}</div>
      <div className="relative h-11 min-w-0 flex-1">
        <div className={`absolute inset-y-2 left-0 rounded-md ${cls}`} style={{ width: pct(m.totalMin, horizon) }} />
        {extra}
        {input.lots.map((l) => (
          <span key={l.id} className="absolute top-0 -translate-x-1/2" style={{ left: pct(m.lotEnds[l.id], horizon) }} title={`${l.label || l.id} が全部終わる`}>
            <LotDot id={l.id} className="ring-2 ring-white" />
          </span>
        ))}
        <span className="absolute bottom-0 whitespace-nowrap text-xs font-black tabular-nums text-slate-900" style={m.totalMin / horizon > 0.75 ? { right: `calc(100% - ${pct(m.totalMin, horizon)} + 4px)` } : { left: `calc(${pct(m.totalMin, horizon)} + 4px)` }}>{n(m.totalMin)}分</span>
      </div>
    </div>
  );
  const gap = base.totalMin - paired.totalMin;
  return (
    <section className={`flex flex-col gap-2 rounded-2xl border-2 p-3 ${tone}`} data-pair-hero="1">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
        <div className={`text-5xl font-black leading-none tabular-nums ${saved ? 'text-emerald-700' : 'text-amber-700'}`}>{saved ? '−' : ''}{n(r.savingsMin)}<span className="ml-1 text-xl">分</span></div>
        <div className={`text-lg font-black ${saved ? 'text-emerald-900' : 'text-amber-900'}`}>{saved ? '早く 2つとも全部終わる' : '掛け持ちしても 早くならない'}</div>
        {saved ? <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-sm font-black text-white">{n(r.savingsPct)}%</span> : null}
      </div>
      <div className="flex flex-col gap-1">
        {bar('baseline', '1ロットずつ', base, 'bg-slate-400')}
        {bar('paired', '掛け持ち', paired, saved ? 'bg-emerald-500' : 'bg-slate-400', gap > 0 ? (
          <div className="absolute inset-y-2 flex items-center justify-center overflow-hidden rounded-md border-2 border-dashed border-emerald-500 text-xs font-black text-emerald-800" style={{ left: pct(paired.totalMin, horizon), width: pct(gap, horizon), ...stripe('#d1fae5', '#ecfdf5') }}>−{n(gap)}分</div>
        ) : null)}
        {alt ? bar('excluded', 'もっと早い案(使わない)', alt.plan.metrics, 'border-2 border-dashed border-rose-500 bg-rose-100') : null}
      </div>
      <div className="flex flex-wrap gap-1.5" data-pair-lot-delta="1">
        {input.lots.map((l) => {
          const d = r.completionDelta[l.id], allowed = input.maxLotDelay?.[l.id] ?? 0;
          const cls = d < 0 ? 'border-emerald-400 bg-white text-emerald-800' : d > allowed + 1e-6 ? 'border-rose-500 bg-rose-50 text-rose-800' : d > 0 ? 'border-amber-400 bg-white text-amber-800' : 'border-slate-300 bg-white text-slate-700';
          return <span key={l.id} className={`inline-flex items-center gap-1 rounded-full border-2 py-0.5 pl-0.5 pr-2 text-sm font-bold ${cls}`}><LotDot id={l.id} />{d === 0 ? '変わらない' : `${n(Math.abs(d))}分${d < 0 ? '早い' : '遅い'}`}</span>;
        })}
        {alt ? alt.violations.map((v) => <span key={v.lotId} className="inline-flex items-center gap-1 rounded-full border-2 border-rose-500 bg-rose-50 py-0.5 pl-0.5 pr-2 text-sm font-bold text-rose-800"><LotDot id={v.lotId} />✕ もっと早い案は 完了が制限を{n(v.excessMin)}分超える</span>) : null}
      </div>
    </section>
  );
}

/** ② 時間の帯。compareEnd を渡すと その時刻との差を 緑(短くなる)/赤(長くなる)の帯で重ねる */
export function Gantt({ plan, input, horizon, title, compareEnd = null, delayOver = {} }) {
  const g = ganttRowsOf(plan, input);
  const step = tickStepOf(horizon);
  const ticks = []; for (let t = 0; t <= horizon + 1e-9; t += step) ticks.push(t);
  const labelW = 'w-14 sm:w-20';
  const flagSide = (t) => (t / horizon > 0.6 ? { right: `calc(100% - ${pct(t, horizon)})` } : { left: pct(t, horizon) });
  const diff = compareEnd != null ? compareEnd - g.total : 0;
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1" data-pair-gantt="1">
      <figcaption className="flex flex-wrap items-center gap-2 text-sm font-black text-slate-900">
        {title}
        <span className="rounded-full bg-slate-900 px-2 py-0.5 text-xs font-bold text-white tabular-nums">{n(g.total)}分で全部終わる</span>
      </figcaption>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <div className="relative pr-5">
          <div className="flex h-6 items-end">
            <div className={`sticky left-0 z-20 ${labelW} shrink-0 bg-white`} />
            <div className="relative h-full flex-1">
              {ticks.map((t, i) => <span key={t} className={`absolute bottom-0 -translate-x-1/2 whitespace-nowrap text-xs tabular-nums text-slate-500 ${i % 2 ? 'hidden sm:inline' : ''}`} style={{ left: pct(t, horizon) }}>{t}分</span>)}
            </div>
          </div>
          {g.rows.map((row) => (
            <div key={row.id} className="flex items-stretch border-t border-slate-100" data-pair-gantt-row={row.id}>
              <div className={`sticky left-0 z-20 flex ${labelW} shrink-0 items-center bg-white px-1 text-xs font-bold leading-tight text-slate-800`}>{row.label}</div>
              <div className="relative h-9 flex-1">
                {ticks.map((t) => <i key={t} className="absolute inset-y-0 w-px bg-slate-100" style={{ left: pct(t, horizon) }} />)}
                {row.segs.map((s, i) => s.kind === 'launch' ? (
                  <span key={i} className="absolute top-0 z-10 -translate-x-1/2 text-xs leading-none text-sky-700" style={{ left: pct(s.start, horizon) }} title={`${s.title} 自動を始める`}>▼</span>
                ) : (
                  <div key={i} className={`absolute inset-y-1 flex items-center overflow-hidden whitespace-nowrap rounded-sm border-r border-white px-0.5 text-xs font-bold ${KIND[s.kind]?.cls || 'bg-slate-500 text-white'}`}
                    style={{ left: pct(s.start, horizon), width: `max(2px, ${pct(s.end - s.start, horizon)})`, ...(KIND[s.kind]?.style || {}) }} title={`${KIND[s.kind]?.word || ''} ${s.title} ${n(s.start)}〜${n(s.end)}分`}>{s.text}</div>
                ))}
              </div>
            </div>
          ))}
          <div className="flex items-stretch border-t border-slate-100">
            <div className={`sticky left-0 z-20 flex ${labelW} shrink-0 items-center bg-white px-1 text-xs font-bold text-slate-800`}>終わる</div>
            <div className="relative h-14 flex-1">
              {input.lots.map((l, li) => {
                const over = delayOver[l.id];
                return (
                  <span key={l.id} className={`absolute inline-flex items-center gap-0.5 whitespace-nowrap rounded-full py-0.5 pl-0.5 pr-1.5 text-xs font-bold tabular-nums ${over ? 'bg-rose-100 text-rose-800 ring-2 ring-rose-500' : 'bg-slate-100 text-slate-800'}`} style={{ top: 2 + li * 26, ...flagSide(g.lotEnds[l.id]) }}>
                    <LotDot id={l.id} />{n(g.lotEnds[l.id])}分{over ? ` ⚠ +${n(over)}分` : ''}
                  </span>
                );
              })}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-y-0 left-14 right-5 sm:left-20">
            {diff > 1e-6 ? (
              <div className="absolute top-6 bottom-0 flex items-start justify-center border-x-2 border-dashed border-emerald-500 pt-1" style={{ left: pct(g.total, horizon), width: pct(diff, horizon), ...stripe('rgba(16,185,129,.18)', 'rgba(16,185,129,.05)') }}>
                <span className="rounded bg-emerald-600 px-1 text-xs font-black text-white">−{n(diff)}分</span>
              </div>
            ) : diff < -1e-6 ? (
              <div className="absolute top-6 bottom-0 border-x-2 border-dashed border-rose-500" style={{ left: pct(compareEnd, horizon), width: pct(-diff, horizon), ...stripe('rgba(244,63,94,.18)', 'rgba(244,63,94,.05)') }} />
            ) : null}
            <div className="absolute top-6 bottom-0 w-0.5 bg-slate-900" style={{ left: pct(g.total, horizon) }} />
          </div>
        </div>
      </div>
    </figure>
  );
}

/** ③ 止まった時: A と B の工程の札を並べ、止めた工程に赤い印。文は下に小さく畳む */
export function StopPicture({ strips, errors, heading }) {
  const p = problemsOf(errors, strips);
  const redPill = (t, i) => <li key={i} className="rounded-md border-2 border-rose-500 bg-white px-1.5 py-0.5 text-xs font-bold text-rose-800">⚠ {t}</li>;
  const lane = (key) => {
    const s = strips && strips[key];
    const marks = p.steps[key];
    return (
      <div className="flex min-w-0 flex-col gap-1" data-pair-stop-lane={key}>
        <div className="flex min-w-0 items-center gap-1.5">
          <LotDot id={key} />
          <b className="min-w-0 truncate text-sm text-slate-900">{s ? s.label : key}</b>
          {s ? <span className="shrink-0 text-xs text-slate-600">{s.units}台</span> : null}
        </div>
        {p.lots[key].length ? <ul className="m-0 flex list-none flex-wrap gap-1 p-0">{p.lots[key].map(redPill)}</ul> : null}
        {s ? (
          <ol className="m-0 flex list-none flex-wrap items-stretch gap-1 p-0">
            {s.steps.map((st) => {
              const bad = marks[st.idx];
              const allDone = st.todo + st.running === 0;
              return (
                <li key={st.idx} className={`flex min-w-[5.5rem] max-w-[10rem] flex-col overflow-hidden rounded-lg border-2 bg-white ${bad ? 'border-rose-500 bg-rose-50' : allDone ? 'border-slate-200 opacity-50' : 'border-slate-300'}`} data-pair-stop-step={bad ? 'bad' : allDone ? 'done' : 'ok'}>
                  <i className={`block h-1.5 ${st.auto ? 'bg-sky-400' : 'bg-emerald-500'}`} />
                  <div className="flex flex-col px-1.5 py-1">
                    <span className="truncate text-xs font-bold text-slate-900">{bad ? '⚠ ' : ''}{st.title}</span>
                    <span className="text-xs tabular-nums text-slate-600">{st.auto ? '自動 ' : st.machine ? '機械 ' : ''}{st.min == null ? '?分' : `${n(st.min)}分`}{allDone ? '・済' : st.done ? `・${st.done}台済` : ''}</span>
                    {bad ? bad.map((w) => <span key={w} className="text-xs font-black leading-tight text-rose-700">{w}</span>) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    );
  };
  const all = errors || [];
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-2xl border-2 border-rose-300 bg-rose-50/60 p-3" role="status" data-pair-stop="1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-rose-600 text-xl font-black text-white">!</span>
        <b className="text-lg text-rose-900">{heading}</b>
        <span className="text-sm text-rose-800">赤い印の所を確かめると 計算します</span>
      </div>
      {p.general.length ? <ul className="m-0 flex list-none flex-wrap gap-1 p-0">{p.general.map(redPill)}</ul> : null}
      {lane('A')}
      <div className="flex items-center gap-2 pl-2" data-pair-stop-travel={p.travel.length ? 'bad' : 'ok'}>
        <span className={`text-lg font-black ${p.travel.length ? 'text-rose-600' : 'text-amber-500'}`}>⇅</span>
        {p.travel.length ? <ul className="m-0 flex list-none flex-wrap gap-1 p-0">{p.travel.map(redPill)}</ul> : <span className="text-xs font-bold text-slate-600">移動</span>}
      </div>
      {lane('B')}
      {all.length ? (
        <details className="text-xs text-slate-700"><summary className="min-h-11 cursor-pointer font-bold">理由の全文({all.length}件)</summary>
          <ul className="m-0 list-disc pl-5">{all.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      ) : null}
    </section>
  );
}

/** 候補の札に添える小さな棒(短くなる=緑・変わらない=灰・止まった=赤) */
export function MiniBar({ result }) {
  if (!result || result.status !== 'ok') return <span className="mt-1 inline-flex items-center gap-1 text-xs font-black text-rose-700"><i className="inline-block h-2.5 w-2.5 rounded-full bg-rose-500" />止まった</span>;
  const base = result.baseline.metrics.totalMin, paired = result.paired.metrics.totalMin;
  return (
    <span className="mt-1 flex w-full flex-col gap-0.5" aria-hidden="true">
      <i className="block h-1.5 rounded-sm bg-slate-400" style={{ width: '100%' }} />
      <i className={`block h-1.5 rounded-sm ${result.savingsMin > 0 ? 'bg-emerald-500' : 'bg-slate-400'}`} style={{ width: pct(paired, base) }} />
    </span>
  );
}
