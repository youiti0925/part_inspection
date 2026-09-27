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
// 🎨 絵の語彙(2026-09-15)。21画面で同じ見た目にする為の共通部品。ここで新しい見た目を作らない。
//   🚨 この部品は数を作らない。computeStrictEvidence が既に返している値を長さ・形へ写すだけ。
import { Bar, StackBar, Dots, Signal } from './opsim/vizKit.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';

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
// 🚦 エビデンスの質 → 信号(色 **と形** の両方が変わる。色だけで見分けさせない決まり)。
//   十分・安定   → 大丈夫(塗った丸)
//   ばらつき大   → 危ない(丸に縦棒)
//   データ薄/根拠なし → 分かりません(点線の輪)
//   🚨 橙(amber)は「空き(スキル待ち)」専用の色なので warn は使わない。
//     「データ薄」は“気を付ける”ではなく“まだ分からない”なので点線の輪が正しい。
const QUALITY_SIGNAL = { good: 'ok', unstable: 'danger', thin: 'unknown', none: 'unknown' };

const fmtWhen = (ts) => { if (!ts) return '-'; const d = new Date(ts); return isNaN(d) ? '-' : `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

function StateBadge({ enabled }) {
  if (enabled === true) return <span className="inline-flex items-center gap-1 text-xs font-black px-2 py-0.5 rounded bg-rose-600 text-white"><Lock className="w-3 h-3" />厳密</span>;
  if (enabled === false) return <span className="inline-flex items-center gap-1 text-xs font-black px-2 py-0.5 rounded bg-slate-200 text-slate-600"><Unlock className="w-3 h-3" />ガイド</span>;
  // 🧹 値の「未設定」も 未/設/定 と縦に折れていた(切り出しで確認)。折り返しを止める。
  // 🚦 決まっていない事は「分かりません」ではなく **まだ選んでいない** なので、点線の輪を横に置く。
  return <span className="inline-flex items-center gap-1 text-xs font-bold text-slate-400 whitespace-nowrap"><Signal level="unknown" size="w-3 h-3" title="まだ決めていません" />未設定</span>;
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
      <div className="fi-tap-text text-slate-400 mb-1">指図 {lot.orderNo}（代表ロット・{lot.units.length}台）／横軸＝実時間（長い空き時間は ┊ で圧縮）</div>
      <div className="space-y-1">
        {lot.units.map((u, ri) => (
          <div key={ri} className="flex items-center gap-2">
            <div className="w-9 fi-tap-text font-bold text-slate-600 shrink-0 text-right flex items-center justify-end gap-0.5">台{u.unitNo}{u.ok ? <CheckCircle2 className="w-3 h-3 text-emerald-500" /> : <AlertTriangle className="w-3 h-3 text-rose-500" />}</div>
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
                  <div key={s.title} className="flex items-center gap-2 fi-tap-text">
                    <div className="w-28 truncate text-slate-400" title={s.title}>{s.title}</div>
                    <div className="flex-1 h-2 rounded border border-dashed border-slate-300 bg-slate-50" />
                    <div className="w-36 text-right text-slate-400 shrink-0">記録なし <span className="text-slate-300">0/{s.started}台</span></div>
                  </div>
                );
                const reliable = s.timed >= 2;
                const ratio = reliable && s.mean > 0 ? Math.min(1, s.std / s.mean) : 0;
                return (
                  <div key={s.title} className="flex items-center gap-2 fi-tap-text">
                    <div className="w-28 truncate text-slate-700 font-bold" title={s.title}>{s.title}</div>
                    <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
                      <div className={`h-2 ${!reliable ? 'bg-amber-300' : ratio > 0.4 ? 'bg-rose-400' : ratio > 0.15 ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: Math.max(4, (reliable ? ratio : 0.5) * 100) + '%' }} />
                    </div>
                    <div className="w-36 text-right font-mono text-slate-600 shrink-0">平均{s.mean}s {reliable ? <span className="text-slate-400">±{s.std}s</span> : <span className="text-amber-600">(1台のみ)</span>}<span className="text-slate-400 ml-1">{s.timed}/{s.started}台</span></div>
                  </div>
                );
              })}
            </div>
            <div className="fi-tap-text text-slate-400 mt-1">※ <b>時間(&gt;0)が記録された台だけ</b>で算出。<b>「記録なし」＝時間が取れていない工程</b>（順番のみ記録）。短い(緑)＝安定／長い(赤)＝バラつき大／1台のみ(橙)＝判定不可。</div>
          </div>
          {/* 複数台の作業の流れ（並行作業のイメージ）— 実時間が十分あるときだけ */}
          <div>
            <div className="text-xs font-black text-slate-700 mb-1.5 flex items-center gap-2 flex-wrap">作業の流れ（並行作業のイメージ）
              <span className="inline-flex items-center gap-1 fi-tap-text text-slate-500"><span className="w-2.5 h-2.5 rounded bg-blue-500 inline-block" /><Hand className="w-3 h-3" />手動</span>
              <span className="inline-flex items-center gap-1 fi-tap-text text-slate-500"><span className="w-2.5 h-2.5 rounded bg-violet-500 inline-block" /><Cpu className="w-3 h-3" />自動測定</span>
            </div>
            {ganttUseful ? (
              <>
                <div className="bg-white rounded border border-slate-200 p-2 max-h-72 overflow-auto"><MultiUnitGantt lot={ganttLot} /></div>
                <div className="fi-tap-text text-slate-400 mt-1">※ 全台が同じ横軸。<b>ある台の自動測定(紫)中に別の台で手動(青)が進んでいれば「自動測定中にできる作業」</b>。細い灰色＝時間記録なし(0s)。✓＝テンプレ順どおり。</div>
              </>
            ) : (
              <div className="bg-white rounded border border-dashed border-slate-300 p-4 fi-tap-text text-slate-500 leading-relaxed">
                <b>時間記録が不十分</b>で、作業の流れ（並行作業のイメージ）は表示できません。<br />各工程の<b>実作業時間</b>が記録された台が増えると表示されます。今は<b>順番の一貫性</b>のみで判断してください。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StrictModeManagerModalBody({ lots, templates, rules = {}, history = [], currentUserName = '', maturityUnits = 5, onSetMaturity, onDecide, onClose, embedded = false, optimalByCombo = {}, onDecideOptimal = null, onOpenAnalysis = null }) {
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
            {/* 🧹 帯を畳む(2026-09-15)。この説明は2行に折り返して赤い見出しの帯を 54px にしていた。
                同じ事が表の下の「💡 「根拠を見る」で…」にも書いてある(重複)。
                → truncate で1行にする。文字は1バイトも消していないので、
                  マウスを載せれば全部読めるし、同じ話は下の 💡 の行にそのまま残っている。 */}
            <div className="fi-tap-text text-rose-100 truncate" title="各コンボの実データを見て判断 →「📊 実データ分析」で全ロットの実作業を確認 → 厳密化／テンプレ改善／様子見 を選ぶ。厳密化はその中の1アクション。">各コンボの実データを見て判断 →「<b>📊 実データ分析</b>」で全ロットの実作業を確認 → <b>厳密化／テンプレ改善／様子見</b>を選ぶ。厳密化はその中の1アクション。</div>
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
              {/* 📊 この画面で一番大事な数(「確立しているのに誰も決めていない 37組」)が、
                  右端の 11px の灰色の字にしか出ていなかった(notext の写しで完全に消える)。
                  1本の帯にして、長さと位置で見えるようにする。
                  ⚠ 数字は1つも消していない。帯のすぐ下に同じ文をそのまま残す。
                  ⚠ 新しい集計はしていない: rows.length / decided / strictOn / goodUndecided は
                    この部品がすぐ上で既に数えている値をそのまま渡しているだけ。
                    ガイドの数は **帯の区間にしない**(decided − strictOn で出すと、同じ数字を
                    2つの計算から出す事になる)。灰色の溝が「まだ決めていない残り」。 */}
              <div className="ml-auto min-w-[16rem]">
                <StackBar height="h-3" total={rows.length}
                  segments={[
                    { key: 'strict', value: strictOn,      tone: 'plain', title: `厳密 ${strictOn} 組` },
                    { key: 'good',   value: goodUndecided, tone: 'ahead', title: `確立し未設定 ${goodUndecided} 組（根拠は揃っている）` },
                  ]} />
                <div className="fi-tap-text text-slate-500 mt-0.5">全 {rows.length} 組 ・ 決定済み {decided}（厳密 {strictOn}）{goodUndecided > 0 && <span className="ml-1 text-emerald-700 font-bold">・確立し未設定 {goodUndecided}</span>}</div>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-slate-100 z-10">
                  <tr className="text-left text-slate-700">
                    <th className="px-2 py-2 font-black border-b border-slate-300 w-6"></th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">品目コード</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300 min-w-[11rem]">テンプレ（工程の並び）</th>
                    {/* 🧹 帯を畳む(2026-09-15)。写しの実測: 見出しの行が **85px** も在った。
                        理由は「完了台数」が 完/了/台/数 と縦1文字ずつに折れていたから(切り出しで確認)。
                        whitespace-nowrap を付けると列が横に開いて見出しは1行(約36px)になり、
                        表の上の帯 179px → 約130px。空いた 49px は行の棒が使う。
                        🚨 文字は1つも変えていない。折り返しを止めただけ。 */}
                    <th className="px-3 py-2 font-black border-b border-slate-300 text-center whitespace-nowrap">完了台数</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">エビデンス（順番の一貫性）</th>
                    {/* 🧹 「状態」も 状/態 と縦に折れていた(実測)。折り返しを止める。 */}
                    <th className="px-3 py-2 font-black border-b border-slate-300 text-center whitespace-nowrap">状態</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300">データ最適順（並行・一括）</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300 whitespace-nowrap">最終変更</th>
                    <th className="px-3 py-2 font-black border-b border-slate-300 text-center sticky right-0 z-20 bg-slate-100">操作</th>
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
                          {/* 📏 2026-09-18: この列に幅の下限が無く、長いテンプレ名(中間分割_回転分割_センタハイト_直角)が 1行3〜4字で5行に折れていた(清水さん「表示がおかしい」)。 */}
                          <td className="px-3 py-2 text-slate-600 min-w-[11rem] leading-snug">{r.templateName}</td>
                          {/* 📏 台数は「確立とみなす台数」(この表のすぐ上で設定している値)と比べないと意味が無いのに、
                              字で 80台 とだけ出ていた。棒＋赤い点線(=しきい値)にして、足りているかを長さで出す。
                              ⚠ 数字「{r.completedUnits}台」は消していない。棒の下に札として残す。
                              ⚠ 棒の長さの元は r.timedUnits / r.completedUnits で、どちらも
                                computeStrictEvidence が既に返している値。ここで足し算はしていない。
                              ⚠ whitespace-nowrap: これが無いと列が潰れて「完/了/台/数」と縦に折れる(実測)。 */}
                          <td className="px-3 py-2 text-center whitespace-nowrap">
                            <Bar value={r.timedUnits} max={r.completedUnits} markAt={maturityUnits}
                                 tone={r.timedUnits >= maturityUnits ? 'ahead' : 'quiet'} height="h-3" className="w-20 mx-auto"
                                 title={`完了 ${r.completedUnits}台 のうち 実時刻が読めるのは ${r.timedUnits}台。赤い点線＝確立とみなす台数 ${maturityUnits}台`} />
                            <div className="font-mono text-slate-700 text-xs mt-0.5">{r.completedUnits}台</div>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* 🚦 質の札に信号(色＋形)を足す。色だけだと白黒で刷った時に読めない。 */}
                              <span className={`inline-flex items-center gap-1 fi-tap-text font-black px-1.5 py-0.5 rounded border whitespace-nowrap ${Q.cls}`}>
                                <Signal level={QUALITY_SIGNAL[r.quality] || 'unknown'} size="w-3 h-3" title={Q.label} />
                                <Q.Icon className="w-3 h-3" />{Q.label}
                              </span>
                              {/* 📏 一貫性を棒の長さにする。99% と 100%、5台中5台 と 80台中79台 が
                                  同じ大きさの字で並んでいて、行を跨いで比べられなかった。
                                  ⚠ 実時刻データが0台の時は Bar が **点線の枠**(=読めていません)を出す。
                                    0% の棒と別の絵になる(部品の決まり)。
                                  ⚠ 数字の文はそのまま下に残す。1文字も消していない。 */}
                              <Bar value={r.timedUnits > 0 ? r.consistentUnits : null} max={r.timedUnits > 0 ? r.timedUnits : null}
                                   tone={r.quality === 'good' ? 'ahead' : r.quality === 'unstable' ? 'late' : 'quiet'}
                                   height="h-3" className="w-28"
                                   title={r.timedUnits > 0 ? `実時刻 ${r.timedUnits}台中 ${r.consistentUnits}台が順番どおり` : '実時刻データなし'} />
                              <span className="text-xs text-slate-600">{r.timedUnits > 0 ? `実時刻 ${r.timedUnits}台中 ${r.consistentUnits}台が順番どおり（${r.consistencyPct}%）` : '実時刻データなし'}</span>
                              <button onClick={() => toggle(r.key)} className="fi-tap-text text-rose-600 hover:underline font-bold">{isOpen ? '閉じる' : '根拠を見る▼'}</button>
                              {onOpenAnalysis && <button onClick={() => onOpenAnalysis(r)} className="fi-tap-text bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-2 py-0.5 rounded flex items-center gap-1">📊 実データ分析</button>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-center"><StateBadge enabled={rule?.enabled} /></td>
                          <td className="px-3 py-2 align-top">
                            {(() => {
                              const o = optimalByCombo[r.key];
                              const oEnabled = rule?.optimalOrder?.enabled === true;
                              if (!o) return <span className="fi-tap-text text-slate-400">対象データなし</span>;
                              const thin = !o.hasEnoughData;            // 時刻ありロットが3件未満
                              const noTimeData = o.lotsWithTime === 0;
                              return (
                                <div className="flex flex-col gap-1 min-w-[200px]">
                                  {/* データ素性を最初に正直に出す */}
                                  <div className={`fi-tap-text font-bold ${thin ? 'text-amber-700' : 'text-slate-500'}`}>
                                    {/* ⚫ 何ロットぶんの時刻が読めているかは、字より点の数の方が速い。
                                        ⚠ 数える所は変えていない。o.lotsWithTime をそのまま並べるだけ。 */}
                                    <Dots count={o.lotsWithTime} cap={12} tone={thin ? 'quiet' : 'plain'} size="w-1.5 h-1.5" className="mr-1 align-middle"
                                          title={`時刻データ ${o.lotsWithTime}/${o.sampleLotCount}ロット`} />
                                    時刻データ {o.lotsWithTime}/{o.sampleLotCount}ロット{o.lotsNoTime > 0 && <span className="text-slate-400">（{o.lotsNoTime}件は時刻なしで除外）</span>}
                                    {thin && <span className="ml-1 bg-amber-100 text-amber-800 px-1 rounded">データ不足・参考値</span>}
                                  </div>
                                  {noTimeData ? (
                                    <div className="fi-tap-text text-slate-400">時刻データが無く算出不可</div>
                                  ) : (
                                    <>
                                      {/* 📏 短縮率を棒にする。▲76% と ▲79% と ▲75% が同じ大きさの字で並んでいて、
                                          どのコンボが一番効くかが行を跨いで比べられなかった。
                                          ⚠ 目盛りは 100(%)固定。o.savedPct は純関数が既に出している値で、
                                            ここで serialSec と optimalSec から計算し直していない
                                            (同じ数字を2つの計算から出さない決まり)。
                                          ⚠ 「▲76% 短縮 (340→80分)」の字はそのまま残す。 */}
                                      <div className="flex items-center gap-1.5">
                                        <Bar value={o.savedPct} max={100} tone="ahead" height="h-3" className="w-16 shrink-0" title={`${o.savedPct}% 短縮`} />
                                        <span className="fi-tap-text text-slate-600 whitespace-nowrap">
                                          <b className="text-indigo-700">▲{o.savedPct}% 短縮</b>
                                          <span className="text-slate-400"> ({Math.round(o.serialSec / 60)}→{Math.round(o.optimalSec / 60)}分)</span>
                                        </span>
                                      </div>
                                      {o.batchSteps.length > 0
                                        ? <div className="fi-tap-text text-slate-500 leading-snug">まとめ作業: {o.batchSteps.map((b, i) => (
                                            <span key={i} className="inline-block mr-1">
                                              {b.title}
                                              {/* 📏 「5/8=63%・参考」は notext でただの灰色の四角だった。
                                                  棒にすると「何台中まとめたか」が長さで出る。
                                                  ⚠ 「5/8=63%・確定/参考」の字は1文字も消していない。 */}
                                              <Bar value={b.batched} max={b.total} tone={b.confident ? 'ahead' : 'quiet'} height="h-1.5" className="w-8 inline-block align-middle mx-0.5"
                                                   title={`${b.title}: ${b.total}台中 ${b.batched}台がまとめ作業（${b.ratePct}%・${b.confident ? '確定' : '参考'}）`} />
                                              <span className={`ml-0.5 px-1 rounded whitespace-nowrap ${b.confident ? 'bg-emerald-100 text-emerald-700 font-bold' : 'bg-slate-100 text-slate-400'}`}>{b.batched}/{b.total}={b.ratePct}%{b.confident ? '・確定' : '・参考'}</span>
                                            </span>
                                          ))}</div>
                                        : <div className="fi-tap-text text-slate-400">まとめ作業の実績なし（時刻データ上）</div>}
                                    </>
                                  )}
                                  {onDecideOptimal && (
                                    <button
                                      onClick={() => onDecideOptimal(r, !oEnabled)}
                                      disabled={rule?.enabled !== true || noTimeData}
                                      title={rule?.enabled !== true ? 'まず「厳密」をONにしてください（最適順は厳密モードの“どの順番か”を決めるもの）' : (thin ? 'データが少ないので強制は非推奨（参考値）' : '')}
                                      className={`mt-0.5 px-2 py-1 rounded fi-tap-text font-bold border w-fit ${rule?.enabled !== true || noTimeData ? 'bg-slate-50 text-slate-300 border-slate-200 cursor-not-allowed' : oEnabled ? 'bg-indigo-600 text-white border-indigo-600' : thin ? 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50' : 'bg-white text-indigo-700 border-indigo-300 hover:bg-indigo-50'}`}
                                    >{oEnabled ? '✓ データ最適順を強制中' : thin ? '強制する（参考・非推奨）' : 'データ最適順を強制する'}</button>
                                  )}
                                </div>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 fi-tap-text text-slate-500 whitespace-nowrap">{rule?.decidedAt ? <>{rule.decidedBy || '?'}<br />{fmtWhen(rule.decidedAt)}</> : '-'}</td>
                          {/* 📌 2026-09-18: 列が増えて表が横に溢れると 操作の札(厳密／ガイド)が画面の外へ出て押せなかった。右端に貼り付ける。 */}
                          <td className="px-3 py-2 sticky right-0 z-10 bg-white shadow-[-0.5rem_0_0.5rem_-0.5rem_rgba(15,23,42,0.18)]">
                            <div className="flex gap-1 justify-center">
                              {/* 🚨 写しの実測(2倍に切り出して確認): 操作の列が約28pxまで潰れ、
                                  押す物の中の字が 厳/密・ガ/イ/ド と **1文字ずつ縦に折れていた**。
                                  押しにくい・読みにくい・押し間違いの元。whitespace-nowrap で止める。
                                  ⚠ 札の字・行き先(onDecide)・色は1つも変えていない。折り返しだけ。 */}
                              <button title="この組み合わせを厳密(順番強制)に" onClick={() => onDecide(r, true)} className={`px-2 py-1 rounded fi-tap-text font-bold border whitespace-nowrap ${rule?.enabled === true ? 'bg-rose-600 text-white border-rose-600' : 'bg-white text-rose-700 border-rose-300 hover:bg-rose-50'}`}>厳密</button>
                              <button title="ガイド(警告のみ・飛ばし可)に" onClick={() => onDecide(r, false)} className={`px-2 py-1 rounded fi-tap-text font-bold border whitespace-nowrap ${rule?.enabled === false ? 'bg-slate-600 text-white border-slate-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}>ガイド</button>
                              {rule?.enabled != null && <button title="未設定に戻す" onClick={() => onDecide(r, null)} className="px-2 py-1 rounded fi-tap-text font-bold border bg-white text-slate-400 border-slate-200 hover:bg-slate-50 whitespace-nowrap">解除</button>}
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
            <div className="shrink-0 px-4 py-2 border-t border-slate-200 bg-slate-50 fi-tap-text text-slate-500">
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
                      <td className="px-3 py-2 fi-tap-text text-slate-600 whitespace-nowrap">{fmtWhen(h.at)}</td>
                      <td className="px-3 py-2 font-bold text-slate-700 whitespace-nowrap">{h.by || '?'}</td>
                      <td className="px-3 py-2 text-slate-700">{h.model} <span className="text-slate-400">×</span> {h.templateName || h.templateId}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><span className="text-slate-400">{lbl(h.old)}</span> <span className="text-slate-400">→</span> <b className={h.new === true ? 'text-rose-700' : 'text-slate-700'}>{lbl(h.new)}</b></td>
                      <td className="px-3 py-2 fi-tap-text text-slate-600">{ev ? `完了${ev.completedUnits ?? ev.completedCount ?? '?'}台・実時刻${ev.timedUnits ?? ev.timedCount ?? '?'}台中${ev.consistentUnits ?? ev.consistentCount ?? '?'}台一致${(ev.consistencyPct != null) ? `(${ev.consistencyPct}%)` : ''}` : '-'}</td>
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

// 🛟 P103: この画面が例外を投げても、この枠だけ「この部分だけ表示できませんでした」にして周りを生かす(製品と同じ包み方)。
export function StrictModeManagerModal(props) {
  return <ErrorBoundary compact where="厳格モードの管理"><StrictModeManagerModalBody {...props} /></ErrorBoundary>;
}
