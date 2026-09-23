// =============================================================================
//  StrictModeManager.jsx — 厳密モードの一元管理（品目コード × テンプレ）
// -----------------------------------------------------------------------------
//  厳密モード＝「1台目から順番」を強制し“飛ばし”を防ぐモード。目的は
//   ①時間データの信頼性(全員同じ順番でないと比較・改善に使えない)
//   ②作業漏れ・検査漏れ防止 ③品質の再現性 ④不慣れな人の誘導。
//  ただし「順番が確立・安定した工程」だけに使うべき(未確立で強制すると融通が利かず逆効果)。
//  → だから「実際に同じ順番で作業されているか(順番の一貫性)」を“台数(台)”ベースで測り、
//    確立したものだけ厳密に、揺れてるものはガイドに留める。
//  ・件数(台数)が揃っただけでは推奨しない。バラつき・作業の流れを見て管理者が納得して決める。
//  ・決定は settings.strictModeRules[combo]、監査は strict_mode_history に追記。
// =============================================================================
import React, { useState, useMemo } from 'react';
import { ShieldCheck, X, Search, History, Lock, Unlock, Info, AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Minus, Cpu, Hand } from 'lucide-react';

export const STRICT_COMBO_SEP = '␟'; // 区切り(通常文字と衝突しない記号)
export const strictComboKey = (model, templateId) => `${model || ''}${STRICT_COMBO_SEP}${templateId || ''}`;
export const parseStrictCombo = (key) => { const i = (key || '').indexOf(STRICT_COMBO_SEP); return i < 0 ? [key, ''] : [key.slice(0, i), key.slice(i + 1)]; };

// 1台(unit u)の「時刻のある工程」を返す [{i,title,category,start,end,dur,isAuto}]
function unitTimedSteps(lot, u) {
  const steps = lot.steps || [], tasks = lot.tasks || {};
  const out = [];
  steps.forEach((s, i) => {
    const t = tasks[`${s.id}-${u}`] || tasks[`${i}-${u}`];
    const st = t && (t.firstStartTime || t.startTime);
    if (!st) return;
    // バーは「実開始」から「実作業時間(duration)」ぶん。endTime は休憩・中断を含み実態より長いので使わない。
    const dur = t.duration || 0;
    out.push({ i, title: s.title, category: s.category, start: st, end: st + Math.max(1, dur) * 1000, dur, isAuto: s.executionMode === 'batch' || (s.title || '').includes('自動') });
  });
  return out;
}
const stdev = (a) => { if (a.length < 2) return 0; const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.round(Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length)); };

// === エビデンス算出(純粋関数・台数ベース)。完了ロットを 品目コード×テンプレ ごとに集計 ===
export function computeStrictEvidence(lots, templates, maturityUnits = 5) {
  const tName = (id) => (templates || []).find(t => t.id === id)?.name || '(テンプレ不明)';
  const completed = (lots || []).filter(l => l.status === 'completed');
  const groups = {};
  completed.forEach(l => { const key = strictComboKey(l.model || '(品目コード空)', l.templateId || ''); (groups[key] = groups[key] || []).push(l); });
  const rows = Object.entries(groups).map(([key, g]) => {
    const [model, tid] = parseStrictCombo(key);
    let completedUnits = 0, timedUnits = 0, consistentUnits = 0;
    const durByStep = {};       // title -> [dur...]
    const lotUnits = {};        // orderNo -> [{unitNo, ok, steps}]  (複数台ガント用)
    g.forEach(lot => {
      const q = lot.quantity || 1; completedUnits += q;
      for (let u = 0; u < q; u++) {
        const arr = unitTimedSteps(lot, u);
        arr.forEach(x => { (durByStep[x.title] = durByStep[x.title] || []).push(x.dur); });
        if (arr.length < 2) continue;
        timedUnits++;
        const actual = [...arr].sort((a, b) => a.start - b.start).map(x => x.i);
        const tmpl = [...arr].sort((a, b) => a.i - b.i).map(x => x.i);
        const ok = JSON.stringify(actual) === JSON.stringify(tmpl);
        if (ok) consistentUnits++;
        (lotUnits[lot.orderNo] = lotUnits[lot.orderNo] || []).push({ unitNo: u + 1, ok, steps: arr.map(x => ({ title: x.title, dur: x.dur, isAuto: x.isAuto, start: x.start, end: x.end })) });
      }
    });
    // 代表ロット = 実際に時間(duration>0)が取れた工程が最も多いロット。並行作業は実時間が無いと見えないため。
    const realDurs = (units) => units.reduce((a, u) => a + u.steps.filter(s => s.dur > 0).length, 0);
    const lotsArr = Object.entries(lotUnits).map(([orderNo, units]) => ({ orderNo, units, real: realDurs(units) })).sort((a, b) => (b.real - a.real) || (b.units.length - a.units.length));
    const ganttLot = lotsArr[0] ? { orderNo: lotsArr[0].orderNo, units: lotsArr[0].units.slice(0, 6) } : null;
    const consistencyPct = timedUnits > 0 ? Math.round(consistentUnits / timedUnits * 100) : null;
    // バラつきは duration>0 (実際に時間が取れた台) だけで算出。0は「未記録」として除外し、記録台数を明示する。
    const stepStats = Object.entries(durByStep).map(([title, all]) => {
      const real = all.filter(d => d > 0);
      return { title, started: all.length, timed: real.length, mean: real.length ? Math.round(real.reduce((x, y) => x + y, 0) / real.length) : 0, std: stdev(real) };
    });
    const timedStepCount = stepStats.filter(s => s.timed > 0).length;
    let quality = 'none';
    if (timedUnits === 0) quality = 'none';
    else if (timedUnits < maturityUnits) quality = 'thin';
    else if (consistencyPct >= 80) quality = 'good';
    else quality = 'unstable';
    return { key, model, templateId: tid, templateName: tName(tid), completedUnits, timedUnits, consistentUnits, consistencyPct, quality, detail: { stepStats, ganttLot, lotCount: lotsArr.length, timedStepCount } };
  });
  rows.sort((a, b) => (b.timedUnits - a.timedUnits) || (b.completedUnits - a.completedUnits) || a.model.localeCompare(b.model));
  return rows;
}

const QUALITY = {
  good:     { cls: 'bg-emerald-100 text-emerald-800 border-emerald-300', Icon: CheckCircle2,  label: '十分・安定' },
  unstable: { cls: 'bg-rose-100 text-rose-800 border-rose-300',          Icon: AlertTriangle, label: 'ばらつき大' },
  thin:     { cls: 'bg-amber-100 text-amber-800 border-amber-300',       Icon: Info,          label: 'データ薄' },
  none:     { cls: 'bg-slate-100 text-slate-500 border-slate-300',       Icon: Minus,         label: '根拠なし' },
};
const fmtWhen = (ts) => { if (!ts) return '-'; const d = new Date(ts); return isNaN(d) ? '-' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function StateBadge({ enabled }) {
  if (enabled === true) return <span className="inline-flex items-center gap-1 text-xs font-black px-2 py-0.5 rounded bg-rose-600 text-white"><Lock className="w-3 h-3" />厳密</span>;
  if (enabled === false) return <span className="inline-flex items-center gap-1 text-xs font-black px-2 py-0.5 rounded bg-slate-200 text-slate-600"><Unlock className="w-3 h-3" />ガイド</span>;
  return <span className="text-xs font-bold text-slate-400">未設定</span>;
}

// 大きな空き時間を圧縮した時間軸(broken-axis)。実時刻t(ms)→表示位置(%)に変換。
// これで「片付けが1.5時間後」のような長い空白でバーが潰れるのを防ぎつつ、実際の前後関係・並行を保つ。
function buildCompressedAxis(intervals, gapMs = 120000) {
  const sorted = [...intervals].filter(iv => iv[1] >= iv[0]).sort((a, b) => a[0] - b[0]);
  if (!sorted.length) return { map: () => 0, breaks: [] };
  const active = [];
  for (const [s, e] of sorted) {
    const last = active[active.length - 1];
    if (last && s <= last[1] + gapMs) last[1] = Math.max(last[1], e); // 近接は1区間に統合
    else active.push([s, e]);
  }
  const GAP_W = 4; // 圧縮した空き1つの表示幅(%)
  const nGaps = active.length - 1;
  const activeTotal = active.reduce((a, [s, e]) => a + Math.max(1, e - s), 0);
  const activeDisplay = Math.max(10, 100 - nGaps * GAP_W);
  const segs = []; let cum = 0;
  active.forEach((seg, i) => {
    if (i > 0) { segs.push({ gap: true, dispStart: cum, dispW: GAP_W }); cum += GAP_W; }
    const w = Math.max(1, seg[1] - seg[0]) / activeTotal * activeDisplay;
    segs.push({ s: seg[0], e: seg[1], dispStart: cum, dispW: w }); cum += w;
  });
  const map = (t) => {
    for (const sd of segs) {
      if (sd.gap) continue;
      if (t <= sd.s) return sd.dispStart;
      if (t <= sd.e) return sd.dispStart + (t - sd.s) / Math.max(1, sd.e - sd.s) * sd.dispW;
    }
    return 100;
  };
  const breaks = segs.filter(s => s.gap).map(s => s.dispStart + s.dispW / 2);
  return { map, breaks };
}

// 複数台の作業の流れ(ガント)。台を行に、工程を実時刻でバー表示(共通の横軸)。手動=青/自動=紫。
// 同じ横軸なので「台Aの自動測定(紫)中に、台Bで手動(青)が動いている」=並行作業が見える。
export function MultiUnitGantt({ lot }) {
  if (!lot || !lot.units || !lot.units.length) return null;
  const allIv = lot.units.flatMap(u => u.steps.map(s => [s.start, s.end]));
  const { map, breaks } = buildCompressedAxis(allIv);
  return (
    <div>
      <div className="text-xs text-slate-400 mb-1">指図 {lot.orderNo}（代表ロット・{lot.units.length}台）／横軸＝実時間（長い空き時間は ┊ で圧縮）</div>
      <div className="space-y-1">
        {lot.units.map((u, ri) => (
          <div key={ri} className="flex items-center gap-2">
            <div className="w-9 text-xs font-bold text-slate-600 shrink-0 text-right flex items-center justify-end gap-0.5">台{u.unitNo}{u.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <AlertTriangle className="w-3 h-3 text-rose-500" />}</div>
            <div className="flex-1 relative h-5 bg-slate-100 rounded">
              {breaks.map((b, i) => <div key={'b' + i} className="absolute top-0 h-5 border-l border-dashed border-slate-300" style={{ left: b + '%' }} />)}
              {u.steps.map((s, i) => {
                const l = map(s.start), w = Math.max(0.8, map(s.end) - l);
                const noDur = !s.dur || s.dur <= 0; // 時間記録なし(0s)は薄い灰でマーカー表示(実作業と区別)
                return <div key={i} className={`absolute top-0.5 h-4 rounded ${noDur ? 'bg-slate-300' : s.isAuto ? 'bg-violet-500' : 'bg-blue-500'} flex items-center overflow-hidden`} style={{ left: l + '%', width: w + '%' }} title={`${s.title}: ${noDur ? '時間記録なし' : s.dur + 's'}`}>{!noDur && w > 7 && <span className="text-[8px] text-white px-1 truncate leading-4">{s.title}</span>}</div>;
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 組み合わせのエビデンス詳細(展開時)。工程ごとのバラつき + 台ごとの作業の流れ。
function EvidenceDetail({ row }) {
  const { stepStats, ganttLot, timedStepCount } = row.detail;
  // ガントは「実時間(>0)が取れた工程」が代表ロットに十分あるときだけ意味がある(0sだらけだと並行作業を読めない)。
  const ganttTotal = ganttLot ? ganttLot.units.reduce((a, u) => a + u.steps.length, 0) : 0;
  const ganttReal = ganttLot ? ganttLot.units.reduce((a, u) => a + u.steps.filter(s => s.dur > 0).length, 0) : 0;
  const ganttUseful = ganttTotal > 0 && ganttReal / ganttTotal >= 0.34;
  return (
    <div className="bg-slate-50 px-4 py-3 border-t border-slate-200">
      {row.timedUnits === 0 ? (
        <div className="text-sm text-slate-500">この組み合わせには<b>実時刻データ（作業の開始・終了の記録）がありません</b>。順番が安定しているかを判断する根拠がないため、厳密モードは推奨できません。まず実際に時間記録された台が貯まるのを待ってください。</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* 工程ごとの時間バラつき (実時間>0の台だけで算出) */}
          <div>
            <div className="text-xs font-black text-slate-700 mb-1.5">工程ごとの時間のバラつき <span className="font-normal text-slate-400">（時間が記録された工程: {timedStepCount}/{stepStats.length}）</span></div>
            <div className="space-y-1">
              {stepStats.map(s => {
                if (s.timed === 0) return (
                  <div key={s.title} className="flex items-center gap-2 text-xs">
                    <div className="w-28 truncate text-slate-400" title={s.title}>{s.title}</div>
                    <div className="flex-1 h-2 rounded border border-dashed border-slate-300 bg-slate-50" />
                    <div className="w-36 text-right text-slate-400 shrink-0">記録なし <span className="text-slate-300">0/{s.started}台</span></div>
                  </div>
                );
                const reliable = s.timed >= 2;
                const ratio = reliable && s.mean > 0 ? Math.min(1, s.std / s.mean) : 0;
                return (
                  <div key={s.title} className="flex items-center gap-2 text-xs">
                    <div className="w-28 truncate text-slate-700 font-bold" title={s.title}>{s.title}</div>
                    <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
                      <div className={`h-2 ${!reliable ? 'bg-amber-300' : ratio > 0.4 ? 'bg-rose-400' : ratio > 0.15 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: Math.max(4, (reliable ? ratio : 0.5) * 100) + '%' }} />
                    </div>
                    <div className="w-36 text-right font-mono text-slate-600 shrink-0">平均{s.mean}s {reliable ? <span className="text-slate-400">±{s.std}s</span> : <span className="text-amber-600">(1台のみ)</span>}<span className="text-slate-400 ml-1">{s.timed}/{s.started}台</span></div>
                  </div>
                );
              })}
            </div>
            <div className="text-xs text-slate-400 mt-1">※ <b>時間(&gt;0)が記録された台だけ</b>で算出。<b>「記録なし」＝時間が取れていない工程</b>（順番のみ記録）。短い(緑)＝安定／長い(赤)＝バラつき大／1台のみ(橙)＝判定不可。</div>
          </div>
          {/* 複数台の作業の流れ（並行作業のイメージ）— 実時間が十分あるときだけ */}
          <div>
            <div className="text-xs font-black text-slate-700 mb-1.5 flex items-center gap-2 flex-wrap">作業の流れ（並行作業のイメージ）
              <span className="inline-flex items-center gap-1 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded bg-blue-500 inline-block" /><Hand className="w-3 h-3" />手動</span>
              <span className="inline-flex items-center gap-1 text-xs text-slate-500"><span className="w-2.5 h-2.5 rounded bg-violet-500 inline-block" /><Cpu className="w-3 h-3" />自動測定</span>
            </div>
            {ganttUseful ? (
              <>
                <div className="bg-white rounded border border-slate-200 p-2 max-h-72 overflow-auto"><MultiUnitGantt lot={ganttLot} /></div>
                <div className="text-xs text-slate-400 mt-1">※ 全台が同じ横軸。<b>ある台の自動測定(紫)中に別の台で手動(青)が進んでいれば「自動測定中にできる作業」</b>。細い灰色＝時間記録なし(0s)。✓＝テンプレ順どおり。</div>
              </>
            ) : (
              <div className="bg-white rounded border border-dashed border-slate-300 p-4 text-xs text-slate-500 leading-relaxed">
                <b>時間記録が不十分</b>で、作業の流れ（並行作業のイメージ）は表示できません。<br />各工程の<b>実作業時間</b>が記録された台が増えると表示されます。今は<b>順番の一貫性</b>のみで判断してください。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function StrictModeManagerModal({ lots, templates, rules = {}, history = [], currentUserName = '', maturityUnits = 5, onSetMaturity, onDecide, onClose, embedded = false, optimalByCombo = {}, onDecideOptimal = null, onOpenAnalysis = null }) {
  const [view, setView] = useState('table');
  const [q, setQ] = useState('');
  const [onlyUndecided, setOnlyUndecided] = useState(false);
  const [expanded, setExpanded] = useState({}); // key -> bool

  const rows = useMemo(() => computeStrictEvidence(lots, templates, maturityUnits), [lots, templates, maturityUnits]);
  const filtered = useMemo(() => rows.filter(r => {
    const kw = q.trim();
    if (kw && !(`${r.model} ${r.templateName}`.includes(kw))) return false;
    if (onlyUndecided && rules[r.key]?.enabled != null) return false;
    return true;
  }), [rows, q, onlyUndecided, rules]);

  const decided = rows.filter(r => rules[r.key]?.enabled != null).length;
  const strictOn = rows.filter(r => rules[r.key]?.enabled === true).length;
  const goodUndecided = rows.filter(r => r.quality === 'good' && rules[r.key]?.enabled == null).length;
  const toggle = (k) => setExpanded(e => ({ ...e, [k]: !e[k] }));

  return (
    <div className={embedded ? 'h-full flex' : 'fixed inset-0 z-[120] bg-slate-900/60 flex items-stretch justify-center md:p-4'} onClick={embedded ? undefined : onClose}>
      <div className={embedded ? 'bg-white rounded-xl border border-slate-200 shadow-sm w-full flex flex-col overflow-hidden h-full' : 'bg-white w-full md:max-w-[1100px] md:rounded-2xl shadow-2xl flex flex-col overflow-hidden'} onClick={e => e.stopPropagation()}>
        <div className="shrink-0 bg-gradient-to-r from-rose-700 to-rose-600 text-white px-5 py-3 flex items-center gap-3">
          <ShieldCheck className="w-6 h-6" />
          <div className="flex-1 min-w-0">
            <div className="font-black text-lg leading-tight">作業データ分析・改善（品目コード × テンプレ）</div>
            <div className="text-xs text-rose-100">各コンボの実データを見て判断 →「<b>📊 実データ分析</b>」で全ロットの実作業を確認 → <b>厳密化／テンプレ改善／様子見</b>を選ぶ。厳密化はその中の1アクション。</div>
          </div>
          <div className="flex bg-white/15 rounded-lg p-0.5">
            <button onClick={() => setView('table')} className={`px-3 py-1.5 rounded text-xs font-bold ${view === 'table' ? 'bg-white text-rose-700' : 'text-white'}`}>管理表</button>
            <button onClick={() => setView('history')} className={`px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1 ${view === 'history' ? 'bg-white text-rose-700' : 'text-white'}`}><History className="w-3.5 h-3.5" />変更履歴</button>
          </div>
          {onClose && <button onClick={onClose} className="bg-white/15 hover:bg-white/30 rounded-full p-2"><X className="w-5 h-5" /></button>}
        </div>

        {view === 'table' ? (
          <>
            <div className="shrink-0 px-4 py-2 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="品目コード・テンプレで絞り込み" className="pl-8 pr-2 py-1.5 text-sm rounded-lg border border-slate-300 outline-none focus:border-rose-500 w-56" />
              </div>
              <label className="flex items-center gap-1.5 text-sm font-bold text-slate-600 cursor-pointer"><input type="checkbox" checked={onlyUndecided} onChange={e => setOnlyUndecided(e.target.checked)} /> 未設定のみ</label>
              <label className="flex items-center gap-1.5 text-sm font-bold text-slate-600">確立とみなす台数:
                <input type="number" min="1" max="999" value={maturityUnits} onChange={e => onSetMaturity && onSetMaturity(Math.max(1, Math.min(999, Number(e.target.value) || 1)))} className="border border-slate-300 rounded px-2 py-1 text-sm w-16" /> 台
              </label>
              <div className="ml-auto text-xs text-slate-500">決定済み {decided}（厳密 {strictOn}）{goodUndecided > 0 && <span className="ml-1 text-emerald-700 font-bold">・確立し未設定 {goodUndecided}</span>}</div>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-slate-100 z-10">
                  <tr className="text-left text-slate-700">
                    <th className="px-2 py-2 font-black border-b border-slate-300 w-6"></th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">品目コード</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">テンプレ（工程の並び）</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300 text-center">完了台数</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">エビデンス（順番の一貫性）</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300 text-center">状態</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">データ最適順（並行・一括）</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">最終変更</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300 text-center">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(r => {
                    const rule = rules[r.key]; const Q = QUALITY[r.quality]; const isOpen = !!expanded[r.key];
                    return (
                      <React.Fragment key={r.key}>
                        <tr className="border-b border-slate-100 hover:bg-rose-50/40 align-top">
                          <td className="px-2 py-2"><button onClick={() => toggle(r.key)} className="text-slate-400 hover:text-rose-600" title="エビデンスを見る">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></td>
                          <td className="px-3 py-2 font-bold text-slate-800 whitespace-nowrap">{r.model}</td>
                          <td className="px-3 py-2 text-slate-600">{r.templateName}</td>
                          <td className="px-3 py-2 text-center font-mono text-slate-700">{r.completedUnits}台</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`inline-flex items-center gap-1 text-xs font-black px-1.5 py-0.5 rounded border ${Q.cls}`}><Q.Icon className="w-3 h-3" />{Q.label}</span>
                              <span className="text-xs text-slate-600">{r.timedUnits > 0 ? `実時刻 ${r.timedUnits}台中 ${r.consistentUnits}台が順番どおり（${r.consistencyPct}%）` : '実時刻データなし'}</span>
                              <button onClick={() => toggle(r.key)} className="text-xs text-rose-600 hover:underline font-bold">{isOpen ? '閉じる' : '根拠を見る▼'}</button>
                              {onOpenAnalysis && <button onClick={() => onOpenAnalysis(r)} className="text-xs bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-2 py-0.5 rounded flex items-center gap-1">📊 実データ分析</button>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center"><StateBadge enabled={rule?.enabled} /></td>
                          <td className="px-3 py-2 align-top">
                            {(() => {
                              const o = optimalByCombo[r.key];
                              const oEnabled = rule?.optimalOrder?.enabled === true;
                              if (!o) return <span className="text-xs text-slate-400">対象データなし</span>;
                              const thin = !o.hasEnoughData;            // 時刻ありロットが3件未満
                              const noTimeData = o.lotsWithTime === 0;
                              return (
                                <div className="flex flex-col gap-1 min-w-[200px]">
                                  {/* データ素性を最初に正直に出す */}
                                  <div className={`text-xs font-bold ${thin ? 'text-amber-700' : 'text-slate-500'}`}>
                                    時刻データ {o.lotsWithTime}/{o.sampleLotCount}ロット{o.lotsNoTime > 0 && <span className="text-slate-400">（{o.lotsNoTime}件は時刻なしで除外）</span>}
                                    {thin && <span className="ml-1 bg-amber-100 text-amber-800 px-1 rounded">データ不足・参考値</span>}
                                  </div>
                                  {noTimeData ? (
                                    <div className="text-xs text-slate-400">時刻データが無く算出不可</div>
                                  ) : (
                                    <>
                                      <div className="text-xs text-slate-600">
                                        <b className="text-indigo-700">▲{o.savedPct}% 短縮</b>
                                        <span className="text-slate-400"> ({Math.round(o.serialSec / 60)}→{Math.round(o.optimalSec / 60)}分)</span>
                                      </div>
                                      {o.batchSteps.length > 0
                                        ? <div className="text-xs text-slate-500 leading-snug">まとめ作業: {o.batchSteps.map((b, i) => (
                                            <span key={i} className="inline-block mr-1">
                                              {b.title}
                                              <span className={`ml-0.5 px-1 rounded ${b.confident ? 'bg-emerald-100 text-emerald-700 font-bold' : 'bg-slate-100 text-slate-400'}`}>{b.batched}/{b.total}={b.ratePct}%{b.confident ? '・確定' : '・参考'}</span>
                                            </span>
                                          ))}</div>
                                        : <div className="text-xs text-slate-400">まとめ作業の実績なし（時刻データ上）</div>}
                                    </>
                                  )}
                                  {onDecideOptimal && (
                                    <button
                                      onClick={() => onDecideOptimal(r, !oEnabled)}
                                      disabled={rule?.enabled !== true || noTimeData}
                                      title={rule?.enabled !== true ? 'まず「厳密」をONにしてください（最適順は厳密モードの“どの順番か”を決めるもの）' : (thin ? 'データが少ないので強制は非推奨（参考値）' : '')}
                                      className={`mt-0.5 px-2 py-1 rounded text-xs font-bold border w-fit ${rule?.enabled !== true || noTimeData ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed' : oEnabled ? 'bg-indigo-600 text-white border-indigo-600' : thin ? 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50' : 'bg-white text-indigo-700 border-indigo-300 hover:bg-indigo-50'}`}
                                    >{oEnabled ? '✓ データ最適順を強制中' : thin ? '強制する（参考・非推奨）' : 'データ最適順を強制する'}</button>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{rule?.decidedAt ? <>{rule.decidedBy || '?'}<br />{fmtWhen(rule.decidedAt)}</> : '-'}</td>
                          <td className="px-3 py-2">
                            <div className="flex gap-1 justify-center">
                              <button title="この組み合わせを厳密(順番強制)に" onClick={() => onDecide(r, true)} className={`px-2 py-1 rounded text-xs font-bold border ${rule?.enabled === true ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-rose-700 border-rose-300 hover:bg-rose-50'}`}>厳密</button>
                              <button title="ガイド(警告のみ・飛ばし可)に" onClick={() => onDecide(r, false)} className={`px-2 py-1 rounded text-xs font-bold border ${rule?.enabled === false ? 'bg-slate-600 text-white border-slate-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>ガイド</button>
                              {rule?.enabled != null && <button title="未設定に戻す" onClick={() => onDecide(r, null)} className="px-2 py-1 rounded text-xs font-bold border bg-white text-slate-400 border-slate-200 hover:bg-slate-50">解除</button>}
                            </div>
                          </td>
                        </tr>
                        {isOpen && <tr><td colSpan={9} className="p-0"><EvidenceDetail row={r} /></td></tr>}
                      </React.Fragment>
                    );
                  })}
                  {filtered.length === 0 && <tr><td colSpan={9} className="text-center py-10 text-slate-400">該当する組み合わせがありません</td></tr>}
                </tbody>
              </table>
            </div>
            <div className="shrink-0 px-4 py-2 border-t border-slate-200 bg-slate-50 text-xs text-slate-500">
              💡 「根拠を見る」で、台ごとの作業の流れ・工程ごとの時間バラつきを確認 → 納得して「厳密／ガイド」を選択。決定時のエビデンスは変更履歴に残ります。データが薄い／ばらつき大のまま厳密にするのは非推奨。
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm border-collapse">
              <thead className="sticky top-0 bg-slate-100 z-10">
                <tr className="text-left text-slate-700">
                  <th className="px-3 py-2 font-black border-b border-slate-300">日時</th>
                  <th className="px-3 py-2 font-black border-b border-slate-300">担当</th>
                  <th className="px-3 py-2 font-black border-b border-slate-300">品目コード × テンプレ</th>
                  <th className="px-3 py-2 font-black border-b border-slate-300">変更</th>
                  <th className="px-3 py-2 font-black border-b border-slate-300">その時のエビデンス</th>
                </tr>
              </thead>
              <tbody>
                {[...history].sort((a, b) => (b.at || 0) - (a.at || 0)).map(h => {
                  const lbl = (v) => v === true ? '厳密' : v === false ? 'ガイド' : '未設定';
                  const ev = h.evidence;
                  return (
                    <tr key={h.id} className="border-b border-slate-100 align-top">
                      <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{fmtWhen(h.at)}</td>
                      <td className="px-3 py-2 font-bold text-slate-700 whitespace-nowrap">{h.by || '?'}</td>
                      <td className="px-3 py-2 text-slate-700">{h.model} <span className="text-slate-400">×</span> {h.templateName || h.templateId}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><span className="text-slate-400">{lbl(h.old)}</span> <span className="text-slate-400">→</span> <b className={h.new === true ? 'text-rose-700' : 'text-slate-700'}>{lbl(h.new)}</b></td>
                      <td className="px-3 py-2 text-xs text-slate-600">{ev ? `完了${ev.completedUnits ?? ev.completedCount ?? '?'}台・実時刻${ev.timedUnits ?? ev.timedCount ?? '?'}台中${ev.consistentUnits ?? ev.consistentCount ?? '?'}台一致${(ev.consistencyPct != null) ? `(${ev.consistencyPct}%)` : ''}` : '-'}</td>
                    </tr>
                  );
                })}
                {history.length === 0 && <tr><td colSpan={5} className="text-center py-10 text-slate-400">まだ変更履歴はありません</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
