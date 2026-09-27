// ============================================================================
// 🖐 作業画面(順序実行)の部品 — 2026-09-24 清水さんが Claude Design の案を「かなり良いと思うのでこのまま進めて」
//   案: https://claude.ai/artifact/6NQHPRWnuVqefLnxKCtXRX (PC / 枠を大きく / 自動運転の待ち / 全工程の順番 / タブレット / スマホ)
// ----------------------------------------------------------------------------
// ここは描くだけ。保存・完了・中断などの動き(onSave を呼ぶ物)は 1つも持たない(全部 App.jsx の作業画面から関数で貰う)。
//   押す物は高さ44px以上(min-h-11)。文字は12px以上(text-xs が床)。
// ============================================================================
import React from 'react';
import { Maximize2, X, ChevronLeft, ChevronRight, RefreshCw, ArrowRight } from 'lucide-react';

const TONE = {
  ok: { text: 'text-emerald-700', bar: 'bg-emerald-500' },
  near: { text: 'text-amber-700', bar: 'bg-amber-500' },
  over: { text: 'text-rose-700', bar: 'bg-rose-500' },
  auto: { text: 'text-violet-700', bar: 'bg-violet-500' },
  none: { text: 'text-slate-700', bar: 'bg-slate-400' },
};
// 🖐 2026-09-24 確かめ役: 該当なし・NG も「済」の緑で見分けが付かなかった → 分ける
const DOT = { done: 'bg-emerald-600', skip: 'bg-white ring-2 ring-slate-400', ng: 'bg-rose-600', run: 'bg-violet-600', active: 'bg-amber-500', rework: 'bg-white ring-2 ring-rose-500', cur: 'bg-blue-600 ring-2 ring-blue-200', todo: 'bg-slate-300' };
const CELL = {
  done: ['済', 'bg-emerald-50 text-emerald-800'],
  skip: ['該当なし', 'bg-slate-100 text-slate-600'],
  ng: ['NG', 'bg-rose-50 text-rose-800'],
  run: ['自動運転中', 'bg-violet-50 text-violet-800'],
  active: ['作業中', 'bg-amber-50 text-amber-900'],
  rework: ['修正中', 'bg-rose-50 text-rose-800'],
  cur: ['いまここ', 'bg-blue-600 text-white'],
  todo: ['—', 'bg-slate-50 text-slate-600'],
};
const CHIP = { unit: 'bg-blue-50 text-blue-700', auto: 'bg-violet-50 text-violet-700', measure: 'bg-emerald-50 text-emerald-700', warn: 'bg-rose-100 text-rose-700', once: 'bg-amber-50 text-amber-800' };

/** 画面の型(説明重視/測定重視/図重視)。作業者ごとに覚える(覚える先は呼ぶ側)。 */
export function SeqPresetSwitch({ presets, value, onChange, note, compact }) {
  return (
    <div className="flex items-center gap-2 shrink-0" data-seq="preset">
      {!compact && note ? <span className="text-xs text-slate-300 whitespace-nowrap">{note}</span> : null}
      <div role="group" aria-label="画面の型" className="flex gap-0.5 rounded-xl bg-slate-900 p-0.5">
        {presets.map((p) => (
          <button key={p.key} type="button" aria-pressed={value === p.key} onClick={() => onChange(p.key)}
            className={`min-h-11 rounded-lg px-3 text-sm font-bold whitespace-nowrap ${value === p.key ? 'bg-white text-slate-900' : 'text-slate-200 hover:bg-white/10'}`}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 今の作業と時間の帯。経過は「この工程×この台」の分、目標は補正込みの目標。 */
export function SeqTimeBand({ name, chips = [], timeLabel, elapsedText, targetText, pct, tone = 'none', note, lotLeftText, lotPct, lotNote, compact }) {
  const t = TONE[tone] || TONE.none;
  return (
    <section aria-label="今の作業と時間" data-seq="time" className={`shrink-0 bg-white border-b border-slate-200 grid gap-x-6 gap-y-2 items-center ${compact ? 'grid-cols-1 px-3 py-2' : 'grid-cols-[minmax(0,1.25fr)_minmax(0,1.3fr)_minmax(0,0.85fr)] px-5 py-3'}`}>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="text-xs font-bold tracking-wider text-slate-500">今の作業</span>
        <span className={`${compact ? 'text-xl' : 'text-2xl'} font-black text-slate-900 leading-tight truncate`} title={name}>{name}</span>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => <span key={c.label} className={`rounded-full px-2.5 py-0.5 text-sm font-bold ${CHIP[c.tone] || CHIP.unit}`}>{c.label}</span>)}
        </div>
      </div>
      <div className="flex flex-col gap-2 min-w-0">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-sm font-bold text-slate-500">{timeLabel}</span>
          <span className={`font-mono font-black leading-none tabular-nums ${compact ? 'text-4xl' : 'text-5xl'} ${t.text}`}>{elapsedText}</span>
          {targetText ? <span className="text-lg font-bold text-slate-600 whitespace-nowrap">/ 目標 {targetText}</span> : <span className="text-sm text-slate-500">目標は まだ決まっていません</span>}
        </div>
        <div className="h-3 rounded-full bg-slate-200 overflow-hidden" aria-hidden="true">
          <div className={`h-3 rounded-full ${t.bar}`} style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%` }} />
        </div>
        {note ? <span className={`text-sm font-bold ${t.text}`}>{note}</span> : null}
      </div>
      <div className={`flex flex-col gap-1.5 min-w-0 ${compact ? 'hidden' : ''}`}>
        <span className="text-xs font-bold tracking-wider text-slate-500">このロット</span>
        <span className="text-xl font-black text-slate-900 whitespace-nowrap">{lotLeftText}</span>
        <div className="h-2 rounded-full bg-slate-200 overflow-hidden" aria-hidden="true"><div className="h-2 bg-slate-500" style={{ width: `${Math.max(0, Math.min(100, lotPct || 0))}%` }} /></div>
        <span className="text-sm text-slate-600">{lotNote}</span>
      </div>
    </section>
  );
}

/** 型式テンプレの順番の帯(押すと全工程の一覧)。点1つ=1台(ロット1回は1つ)。 */
export function SeqOrderStrip({ steps, grid, curS, onOpen, compact }) {
  return (
    <nav aria-label="この型式テンプレの順番" data-seq="strip" className={`shrink-0 bg-white border-b border-slate-200 flex gap-1.5 items-stretch ${compact ? 'px-3 py-2 overflow-x-auto' : 'px-5 py-2'}`}>
      {grid.map((g) => {
        const st = steps[g.s] || {};
        const isCur = g.s === curS;
        const cls = isCur ? 'border-blue-600 bg-blue-50 text-blue-900' : g.allDone ? 'border-slate-200 bg-slate-50 text-emerald-800' : 'border-slate-200 bg-white text-slate-700';
        return (
          <button key={g.s} type="button" onClick={onOpen} title={st.title || ''} aria-label={`${g.s + 1}. ${st.title || ''}（全工程の順番を開く）`}
            className={`min-h-14 rounded-lg border-2 px-2 py-1 flex flex-col justify-center gap-1.5 text-left ${compact ? 'shrink-0' : 'flex-1 min-w-0'} ${cls}`}>
            <span className="flex items-baseline gap-1 min-w-0 w-full">
              <span className="text-xs font-bold opacity-80">{g.s + 1}</span>
              {!compact ? <span className="text-sm font-bold truncate">{st.title || ''}</span> : null}
            </span>
            <span className="flex gap-1 flex-wrap">
              {g.units.map((x) => <span key={x.u} aria-hidden="true" className={`block h-2.5 w-2.5 rounded-full ${DOT[x.status] || DOT.todo}`} />)}
            </span>
          </button>
        );
      })}
      <button type="button" onClick={onOpen} className="shrink-0 min-h-14 rounded-lg border border-slate-300 bg-slate-50 px-3 text-sm font-bold text-slate-800 whitespace-nowrap">全工程の順番</button>
    </nav>
  );
}

/** 全工程の順番(見るだけ)。順番を変える時はカスタム画面。 */
export function SeqOrderSheet({ steps, grid, qty, title, targetTextOf, onClose, onCustom }) {
  const cols = Math.max(1, Math.min(qty, 12));
  const gridCols = { gridTemplateColumns: `2.25rem minmax(0,2.2fr) 5.5rem repeat(${cols}, minmax(0,1fr))` };
  return (
    <div className="fixed inset-0 z-[160] bg-slate-900/60 flex items-center justify-center p-4" onClick={onClose}>
      <section role="dialog" aria-label="この型式テンプレの順番" data-seq="sheet" className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 p-5 pb-3 shrink-0">
          <div className="flex flex-col gap-1 min-w-0">
            <h2 className="text-xl font-black text-slate-900">この型式テンプレの順番</h2>
            <span className="text-sm text-slate-600">{title}。見るだけの一覧です（順番を変える時はカスタム画面）。</span>
          </div>
          <div className="flex-1" />
          <button type="button" onClick={onClose} aria-label="順番の一覧を閉じる" className="min-h-11 min-w-11 flex items-center justify-center rounded-xl border border-slate-300 text-slate-700"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-5 overflow-y-auto flex flex-col gap-1.5">
          <div className="grid gap-1.5 text-xs font-bold text-slate-500 sticky top-0 bg-white py-1" style={gridCols}>
            <span /> <span>工程</span><span>目標</span>
            {Array.from({ length: cols }, (_, i) => <span key={i} className="text-center">{i + 1}台目</span>)}
          </div>
          {grid.map((g) => {
            const st = steps[g.s] || {};
            return (
              <div key={g.s} className="grid gap-1.5 items-center" style={gridCols}>
                <span className="text-sm font-black text-slate-500">{g.s + 1}</span>
                <span className="text-sm font-bold text-slate-900 truncate" title={st.title || ''}>{st.title || ''}{st.lotOnce ? <span className="ml-1 text-xs font-bold text-amber-800">ロット1回</span> : null}</span>
                <span className="font-mono text-sm text-slate-600">{targetTextOf(g.s)}</span>
                {g.units.slice(0, cols).map((x) => {
                  const [label, cls] = CELL[x.status] || CELL.todo;
                  return <span key={x.u} className={`min-h-9 flex items-center justify-center rounded-lg text-xs font-bold ${cls}`} style={st.lotOnce ? { gridColumn: `span ${cols}` } : undefined}>{label}</span>;
                })}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 p-5 pt-3 shrink-0 flex-wrap">
          <span className="text-sm text-slate-600">緑＝済 灰＝該当なし 赤＝NG・修正中 紫＝自動運転中 橙＝カスタムで作業中 青＝いまここ{qty > 12 ? `（13台目から先はカスタム画面で見られます）` : ''}</span>
          <div className="flex-1" />
          {onCustom ? <button type="button" onClick={onCustom} className="min-h-11 rounded-xl border border-slate-300 px-4 text-sm font-bold text-slate-800">カスタム画面で開く</button> : null}
          <button type="button" onClick={onClose} className="min-h-11 rounded-xl bg-slate-900 px-5 text-sm font-black text-white">閉じる</button>
        </div>
      </section>
    </div>
  );
}

/** 1つの枠(作業内容・図・測定・この後の流れ)。右上の「大きく」で大きく表示へ。 */
export function SeqPanel({ area, title, sub, onZoom, zoomLabel, accent = false, children }) {
  return (
    <section aria-label={title} data-seq-panel={area} style={area ? { gridArea: area } : undefined}
      className={`min-h-0 min-w-0 flex flex-col gap-2.5 rounded-2xl bg-white p-4 overflow-hidden ${accent ? 'border-2 border-emerald-200' : 'border border-slate-200'}`}>
      <div className="flex items-center gap-2 shrink-0">
        <h2 className="text-sm font-black text-slate-700">{title}</h2>
        {sub ? <span className="text-sm font-bold text-emerald-700">{sub}</span> : null}
        <div className="flex-1" />
        {onZoom ? (
          <button type="button" onClick={onZoom} aria-label={zoomLabel || `${title}を大きく表示`} className="min-h-11 flex items-center gap-1.5 rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-700">
            <Maximize2 className="w-4 h-4" /> 大きく
          </button>
        ) : null}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </section>
  );
}

/** この後の流れ(図も測定も無い工程で、右の枠に出す)。 */
export function SeqUpcoming({ items }) {
  if (!items.length) return <p className="text-sm text-slate-600">この後の作業はありません。</p>;
  return (
    <ol className="flex flex-col gap-2">
      {items.map((it, i) => (
        <li key={it.key} className={`min-h-12 flex items-center gap-3 rounded-xl border px-3 py-1.5 ${i === 0 ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'}`}>
          <div className="flex flex-col min-w-0 flex-1">
            <span className="text-base font-bold text-slate-900 truncate">{it.title}</span>
            <span className="text-sm text-slate-600">{it.unit}{it.auto ? ' ・ 自動運転' : ''}</span>
          </div>
          <span className="font-mono text-sm font-bold text-slate-600">{it.target}</span>
        </li>
      ))}
    </ol>
  );
}

/** 大きく表示(枠の中身を大きく・左右で枠を切替・戻るは1回)。 */
export function SeqZoom({ tabs, active, onPick, onPrev, onNext, onClose, children }) {
  return (
    <section aria-label="大きく表示" data-seq="zoom" className="absolute inset-0 z-20 flex flex-col gap-3 rounded-2xl border border-slate-300 bg-white p-4 shadow-2xl">
      <div className="flex items-center gap-2 shrink-0 flex-wrap">
        <div role="group" aria-label="表示する枠" className="flex gap-1.5 flex-wrap">
          {tabs.map((t) => (
            <button key={t.key} type="button" aria-pressed={t.key === active} onClick={() => onPick(t.key)}
              className={`min-h-12 rounded-xl px-5 text-base font-black ${t.key === active ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-700'}`}>{t.label}</button>
          ))}
        </div>
        <div className="flex-1" />
        {tabs.length > 1 ? (
          <>
            <button type="button" onClick={onPrev} aria-label="前の枠" className="min-h-12 min-w-12 flex items-center justify-center rounded-xl border border-slate-300 text-slate-800"><ChevronLeft className="w-6 h-6" /></button>
            <button type="button" onClick={onNext} aria-label="次の枠" className="min-h-12 min-w-12 flex items-center justify-center rounded-xl border border-slate-300 text-slate-800"><ChevronRight className="w-6 h-6" /></button>
          </>
        ) : null}
        <button type="button" onClick={onClose} className="min-h-12 flex items-center gap-2 rounded-xl bg-slate-900 px-5 text-base font-black text-white"><X className="w-5 h-5" /> 戻る</button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">{children}</div>
    </section>
  );
}

/** 自動運転を始めた後の待ち。待っている間にできる手作業を出す(押すと その作業へ移る)。 */
export function SeqWaitCard({ title, unitLabel, leftText, pct, overText, suggestion, onSuggest, noSuggestion, onAutoDone, autoDoneLabel, alsoLabel, onAlso }) {
  return (
    <section aria-label="自動運転の待ち時間" data-seq="wait" className="h-full min-h-[20rem] flex flex-col items-center justify-center gap-4 rounded-2xl border-2 border-violet-300 bg-white p-6 text-center">
      <div className="flex items-center gap-2 text-violet-700">
        <RefreshCw className="w-7 h-7" />
        <span className="text-xl font-black">自動運転中 {unitLabel} {title}</span>
      </div>
      <div className="flex items-baseline gap-3">
        <span className="text-base font-bold text-slate-600">{overText ? '予定を過ぎて' : '残り'}</span>
        <span className={`font-mono text-6xl font-black leading-none tabular-nums ${overText ? 'text-rose-700' : 'text-violet-800'}`}>{overText || leftText}</span>
      </div>
      <div className="w-3/5 h-3 rounded-full bg-violet-100 overflow-hidden" aria-hidden="true"><div className="h-3 bg-violet-500" style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%` }} /></div>
      <div className="w-3/4 h-px bg-slate-200" />
      {suggestion ? (
        <>
          <span className="text-base font-bold text-slate-700">{suggestion}</span>
          <button type="button" onClick={onSuggest} className="min-h-16 flex items-center gap-3 rounded-2xl bg-blue-700 px-8 text-xl font-black text-white shadow-lg">
            その作業へ移る <ArrowRight className="w-6 h-6" />
          </button>
        </>
      ) : <span className="text-base font-bold text-slate-700">{noSuggestion}</span>}
      {/* 機械が2台以上ある時の逃げ道(既定は1台ずつ) */}
      {alsoLabel ? <button type="button" onClick={onAlso} className="min-h-11 rounded-xl border-2 border-blue-200 bg-white px-5 text-sm font-bold text-blue-800">{alsoLabel}</button> : null}
      {onAutoDone ? <button type="button" onClick={onAutoDone} className="min-h-11 rounded-xl border-2 border-violet-200 bg-white px-5 text-sm font-bold text-violet-800">{autoDoneLabel}</button> : null}
    </section>
  );
}
